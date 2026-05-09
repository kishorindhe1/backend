import { Op }                             from 'sequelize';
import { sequelize }                     from '../../config/database';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import {
  OpdSlotSession, OpdSlotStatus,
  OpdSession, OpdSessionStatus, OpdBookingMode,
  Appointment, AppointmentStatus, PaymentStatus,
  AppointmentType, PaymentMode, CancellationBy,
  DoctorProfile,
  DoctorHospitalAffiliation,
  Hospital, AppointmentApprovalMode, PaymentCollectionMode,
  OpdToken, OpdTokenType, OpdTokenStatus,
  DoctorBookingPreference,
  ConsultationQueue, QueueStatus,
  WaitlistEntry, WaitlistStatus,
}                                         from '../../models';
import { env }                           from '../../config/env';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok, fail }     from '../../types';
import { logger }                        from '../../utils/logger';
import { incrementCounter } from '../admin/admin.service';
import { addToQueue, invalidateQueueCache } from '../queue/queue.service';
import { enqueueNotification }           from '../notifications/notification.service';
import { NotificationChannel }           from '../../models';

// ── Fee split ─────────────────────────────────────────────────────────────────
function calcFee(amount: number) {
  const platform_fee  = Math.round(amount * (env.PLATFORM_FEE_PERCENTAGE / 100) * 100) / 100;
  const doctor_payout = amount - platform_fee;
  return { platform_fee, doctor_payout };
}

// ── Book appointment ──────────────────────────────────────────────────────────
export interface BookAppointmentInput {
  patient_id:        string;
  doctor_id:         string;
  hospital_id:       string;
  slot_id?:          string;    // slot-based booking
  session_id?:       string;    // token/queue-based booking (mutually exclusive with slot_id)
  notes?:            string;
  appointment_type?: AppointmentType;
  payment_mode?:     PaymentMode; // only honoured when hospital.payment_collection_mode = 'patient_choice'
}

// ── Queue-based booking (token mode) ─────────────────────────────────────────
async function bookQueueAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  const { patient_id, doctor_id, hospital_id, session_id, notes } = input;

  const lockKey = `lock:opd:session:${session_id}`;
  const lockVal = `${patient_id}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', 10, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SESSION_LOCK', 'Session is busy, please retry in a moment.');

  try {
    const session = await OpdSession.findByPk(session_id!);
    if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Queue session not found.');
    if (session.booking_mode !== OpdBookingMode.TOKEN_BASED) {
      throw ErrorFactory.unprocessable('NOT_QUEUE_SESSION', 'This session does not use queue-based booking.');
    }
    if (![OpdSessionStatus.SCHEDULED, OpdSessionStatus.ACTIVE].includes(session.status as OpdSessionStatus)) {
      throw ErrorFactory.unprocessable('SESSION_UNAVAILABLE', `Session is ${session.status} and not accepting bookings.`);
    }
    if (session.tokens_issued >= session.total_tokens) {
      throw ErrorFactory.conflict('SESSION_FULL', 'This session is fully booked.');
    }

    // One active token per patient per session
    const existingToken = await OpdToken.findOne({
      where: {
        session_id: session_id!,
        patient_id,
        status: { [Op.notIn]: [OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW] },
      },
    });
    if (existingToken) {
      throw ErrorFactory.conflict('ALREADY_IN_QUEUE', `You already have token #${existingToken.token_number} in this session.`);
    }

    const hospital = await Hospital.findByPk(hospital_id, { attributes: ['appointment_approval', 'payment_collection_mode'] });
    if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');
    const isAutoApproval = hospital.appointment_approval === AppointmentApprovalMode.AUTO;

    // Booking preference checks — treat session start as the appointment time
    const pref = await DoctorBookingPreference.findOne({ where: { doctor_id, hospital_id } });
    if (pref) {
      const slotTime = new Date(`${session.session_date}T${session.start_time}:00`).getTime();
      const now      = Date.now();
      if (pref.min_booking_lead_hours > 0 && slotTime - now < pref.min_booking_lead_hours * 3_600_000) {
        throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
      }
      if (pref.booking_cutoff_hours > 0 && slotTime - now < pref.booking_cutoff_hours * 3_600_000) {
        throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings close ${pref.booking_cutoff_hours}h before the session.`);
      }
    }

    let resolvedPaymentMode: PaymentMode;
    if (hospital.payment_collection_mode === PaymentCollectionMode.CASH_ONLY) {
      resolvedPaymentMode = PaymentMode.CASH;
    } else if (hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE && input.payment_mode) {
      resolvedPaymentMode = input.payment_mode;
    } else {
      resolvedPaymentMode = PaymentMode.ONLINE_PREPAID;
    }

    const scheduledAt = new Date(`${session.session_date}T${session.start_time}:00`);

    const { appointment, tokenNumber } = await sequelize.transaction(async (t) => {
      // Re-check capacity inside transaction
      const locked = await OpdSession.findOne({
        where: { id: session_id! },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!locked || locked.tokens_issued >= locked.total_tokens) {
        throw ErrorFactory.conflict('SESSION_FULL', 'Session just filled up. Please try another session.');
      }

      const affiliation = await DoctorHospitalAffiliation.findOne({
        where: { doctor_id, hospital_id, is_active: true }, transaction: t,
      });
      if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.');

      const fee    = Number(affiliation.consultation_fee);
      const splits = calcFee(fee);

      const isCashOrCard    = resolvedPaymentMode === PaymentMode.CASH || resolvedPaymentMode === PaymentMode.CARD;
      const doctorNeedsApproval = pref?.requires_booking_approval === true;
      let initialStatus: AppointmentStatus;
      if (!isAutoApproval || doctorNeedsApproval) {
        initialStatus = AppointmentStatus.AWAITING_HOSPITAL_APPROVAL;
      } else if (isCashOrCard) {
        initialStatus = AppointmentStatus.CONFIRMED;
      } else {
        initialStatus = AppointmentStatus.PENDING;
      }

      const appt = await Appointment.create({
        patient_id, doctor_id, hospital_id,
        slot_id:          null,
        scheduled_at:     scheduledAt,
        status:           initialStatus,
        payment_status:   PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode:     resolvedPaymentMode,
        consultation_fee: fee,
        platform_fee:     splits.platform_fee,
        doctor_payout:    splits.doctor_payout,
        notes:            notes ?? null,
        cancellation_reason: null, cancelled_by: null, cancelled_at: null,
        razorpay_order_id: null,
      }, { transaction: t });

      const maxToken = (await OpdToken.max('token_number', { where: { session_id: session_id! }, transaction: t }) as number | null) ?? 0;
      const newTokenNumber = maxToken + 1;

      await OpdToken.create({
        session_id:                    session_id!,
        token_number:                  newTokenNumber,
        patient_id,
        appointment_id:                appt.id,
        token_type:                    OpdTokenType.ONLINE,
        issued_by:                     'online_booking',
        arrived_at:                    null, called_at: null,
        consultation_start:            null, consultation_end: null,
        status:                        OpdTokenStatus.ISSUED,
        personalized_duration_minutes: null,
        duration_override:             null,
      }, { transaction: t });

      await locked.update({ tokens_issued: locked.tokens_issued + 1 }, { transaction: t });

      return { appointment: appt, tokenNumber: newTokenNumber };
    });

    await addToQueue(appointment.id, doctor_id, hospital_id, patient_id, scheduledAt);

    const doctor = await DoctorProfile.findByPk(doctor_id, { attributes: ['full_name'] });
    const pendingAhead     = Math.max(0, session.tokens_issued - session.current_token);
    const estimatedWait    = pendingAhead * Number(session.avg_time_per_patient);

    await enqueueNotification({
      userId:        patient_id,
      appointmentId: appointment.id,
      type:          isAutoApproval ? 'booking_confirmed' : 'booking_awaiting_approval',
      channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority:      'high',
      data: {
        name:   'Patient',
        doctor: doctor?.full_name ?? 'Doctor',
        date:   scheduledAt.toDateString(),
        time:   session.start_time,
        token:  String(tokenNumber),
      },
    });

    await incrementCounter('bookings');
    logger.info('Queue appointment booked', { appointmentId: appointment.id, patientId: patient_id, tokenNumber });

    return ok({
      appointment_id:          appointment.id,
      status:                  appointment.status,
      payment_status:          appointment.payment_status,
      scheduled_at:            appointment.scheduled_at,
      consultation_fee:        Number(appointment.consultation_fee),
      platform_fee:            Number(appointment.platform_fee),
      doctor_payout:           Number(appointment.doctor_payout),
      razorpay_order_id:       null,
      token_number:            tokenNumber,
      session_id:              session_id!,
      session_type:            session.session_type,
      estimated_wait_minutes:  estimatedWait,
    });

  } finally {
    const cur = await redis.get(lockKey);
    if (cur === lockVal) await redis.del(lockKey);
  }
}

export async function bookAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  if (input.session_id && !input.slot_id) return bookQueueAppointment(input);

  const { patient_id, doctor_id, hospital_id, slot_id, notes } = input;
  if (!slot_id) throw ErrorFactory.unprocessable('MISSING_SLOT', 'Either slot_id or session_id is required.');

  // Layer 1 — Redis distributed lock
  const lockKey = `lock:slot:${slot_id}`;
  const lockVal = `${patient_id}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot is currently being booked. Please try another.');

  try {
    // One active booking per patient per doctor per day
    const slotForDateCheck = await OpdSlotSession.findByPk(slot_id, { attributes: ['date'] });
    if (slotForDateCheck) {
      const dateStr = slotForDateCheck.date;
      const existingToday = await Appointment.findOne({
        where: {
          patient_id, doctor_id,
          status: { [Op.in]: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL] },
          scheduled_at: { [Op.between]: [new Date(`${dateStr}T00:00:00`), new Date(`${dateStr}T23:59:59`)] },
        },
      });
      if (existingToday) {
        throw ErrorFactory.conflict('DUPLICATE_BOOKING', 'You already have an active booking with this doctor today.');
      }
    }

    // Check hospital settings before the transaction
    const hospital = await Hospital.findByPk(hospital_id, { attributes: ['appointment_approval', 'payment_collection_mode'] });
    if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');
    const isAutoApproval = hospital.appointment_approval === AppointmentApprovalMode.AUTO;

    // ── Doctor booking preference checks (lead time + cutoff only) ──────────────
    const pref = await DoctorBookingPreference.findOne({ where: { doctor_id, hospital_id } });
    if (pref) {
      const prefSlot = await OpdSlotSession.findByPk(slot_id, { attributes: ['date', 'slot_start_time'] });
      if (prefSlot) {
        const now      = new Date();
        const slotTime = new Date(`${prefSlot.date}T${prefSlot.slot_start_time}:00`).getTime();

        if (pref.min_booking_lead_hours > 0 && slotTime - now.getTime() < pref.min_booking_lead_hours * 3_600_000) {
          throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
        }
        if (pref.booking_cutoff_hours > 0 && slotTime - now.getTime() < pref.booking_cutoff_hours * 3_600_000) {
          throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings for this doctor close ${pref.booking_cutoff_hours}h before the slot.`);
        }
      }
    }
    // ── End pre-transaction preference checks ─────────────────────────────────

    // Resolve payment mode based on hospital collection policy
    let resolvedPaymentMode: PaymentMode;
    if (hospital.payment_collection_mode === PaymentCollectionMode.CASH_ONLY) {
      resolvedPaymentMode = PaymentMode.CASH;
    } else if (hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE && input.payment_mode) {
      resolvedPaymentMode = input.payment_mode;
    } else {
      resolvedPaymentMode = PaymentMode.ONLINE_PREPAID;
    }

    const result = await sequelize.transaction(async (t) => {
      // Layer 2 — SELECT FOR UPDATE
      const slot = await OpdSlotSession.findOne({
        where: { id: slot_id, doctor_id, hospital_id },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!slot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'Slot not found.');
      if (slot.status !== OpdSlotStatus.PUBLISHED) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      const slotDateTime = new Date(`${slot.date}T${slot.slot_start_time}:00`);
      if (slotDateTime < new Date()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot book a past slot.');

      const affiliation = await DoctorHospitalAffiliation.findOne({ where: { doctor_id, hospital_id, is_active: true }, transaction: t });
      if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.');

      const fee    = Number(affiliation.consultation_fee);
      const splits = calcFee(fee);

      // Determine initial appointment status
      const doctorRequiresApproval = pref?.requires_booking_approval === true;
      const isCashOrCard = resolvedPaymentMode === PaymentMode.CASH || resolvedPaymentMode === PaymentMode.CARD;
      let initialStatus: AppointmentStatus;
      if (!isAutoApproval || doctorRequiresApproval) {
        initialStatus = AppointmentStatus.AWAITING_HOSPITAL_APPROVAL;
      } else if (isCashOrCard) {
        initialStatus = AppointmentStatus.CONFIRMED; // no online payment needed
      } else {
        initialStatus = AppointmentStatus.PENDING;   // awaiting online payment
      }

      // Daily cap checks — inside the transaction so read + insert are atomic
      if (pref) {
        const dayStart    = new Date(`${slot.date}T00:00:00`);
        const dayEnd      = new Date(`${slot.date}T23:59:59`);
        const capStatuses = [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL];

        if (pref.max_new_patients_per_day != null && input.appointment_type !== AppointmentType.FOLLOW_UP) {
          const count = await Appointment.count({
            where: { doctor_id, hospital_id, appointment_type: { [Op.ne]: AppointmentType.FOLLOW_UP }, status: { [Op.in]: capStatuses }, scheduled_at: { [Op.between]: [dayStart, dayEnd] } },
            transaction: t,
          });
          if (count >= pref.max_new_patients_per_day) throw ErrorFactory.conflict('DAILY_NEW_PATIENT_LIMIT', 'Daily new patient limit reached for this doctor.');
        }

        if (pref.max_followups_per_day != null && input.appointment_type === AppointmentType.FOLLOW_UP) {
          const count = await Appointment.count({
            where: { doctor_id, hospital_id, appointment_type: AppointmentType.FOLLOW_UP, status: { [Op.in]: capStatuses }, scheduled_at: { [Op.between]: [dayStart, dayEnd] } },
            transaction: t,
          });
          if (count >= pref.max_followups_per_day) throw ErrorFactory.conflict('DAILY_FOLLOWUP_LIMIT', 'Daily follow-up limit reached for this doctor.');
        }
      }

      // Layer 3 — unique slot_id constraint catches any slip-through
      const appointment = await Appointment.create({
        patient_id, doctor_id, hospital_id, slot_id,
        scheduled_at:     slotDateTime,
        status:           initialStatus,
        payment_status:   PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode:     resolvedPaymentMode,
        consultation_fee: fee,
        platform_fee:     splits.platform_fee,
        doctor_payout:    splits.doctor_payout,
        notes:            notes ?? null,
        cancellation_reason: null, cancelled_by: null, cancelled_at: null,
        razorpay_order_id: null,
      }, { transaction: t });

      await slot.update({ status: OpdSlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });

      // Issue an ONLINE token in the unified session queue
      if (slot.session_id) {
        const maxToken = (await OpdToken.max('token_number', { where: { session_id: slot.session_id }, transaction: t }) as number | null) ?? 0;
        await OpdToken.create({
          session_id:   slot.session_id,
          token_number: maxToken + 1,
          patient_id:   appointment.patient_id,
          appointment_id: appointment.id,
          token_type:   OpdTokenType.ONLINE,
          issued_by:    'online_booking',
          status:       OpdTokenStatus.ISSUED,
        }, { transaction: t });
      }

      return appointment;
    });

    // Invalidate slot cache
    const dateStr = result.scheduled_at.toISOString().split('T')[0];
    await redis.del(RedisKeys.publishedSlots(doctor_id, dateStr));

    // Add to consultation queue
    await addToQueue(result.id, doctor_id, hospital_id, patient_id, result.scheduled_at);

    const doctor = await DoctorProfile.findByPk(doctor_id, { attributes: ['full_name'] });

    if (isAutoApproval) {
      await enqueueNotification({
        userId:        patient_id,
        appointmentId: result.id,
        type:          'booking_confirmed',
        channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
        priority:      'high',
        data: {
          name:   'Patient',
          doctor: doctor?.full_name ?? 'Doctor',
          date:   result.scheduled_at.toDateString(),
          time:   result.scheduled_at.toTimeString().slice(0, 5),
          token:  '—',
        },
      });
    } else {
      await enqueueNotification({
        userId:        patient_id,
        appointmentId: result.id,
        type:          'booking_awaiting_approval',
        channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
        priority:      'high',
        data: {
          name:   'Patient',
          doctor: doctor?.full_name ?? 'Doctor',
          date:   result.scheduled_at.toDateString(),
          time:   result.scheduled_at.toTimeString().slice(0, 5),
        },
      });
    }

    await incrementCounter('bookings');
    logger.info('Appointment booked', { appointmentId: result.id, patientId: patient_id, approval_mode: hospital.appointment_approval });

    return ok({
      appointment_id:   result.id,
      status:           result.status,
      payment_status:   result.payment_status,
      scheduled_at:     result.scheduled_at,
      consultation_fee: Number(result.consultation_fee),
      platform_fee:     Number(result.platform_fee),
      doctor_payout:    Number(result.doctor_payout),
      razorpay_order_id: result.razorpay_order_id,
    });

  } finally {
    const cur = await redis.get(lockKey);
    if (cur === lockVal) await redis.del(lockKey);
  }
}

// ── Cancel appointment ────────────────────────────────────────────────────────
export async function cancelAppointment(
  appointmentId: string,
  requesterId:   string,
  cancelledBy:   CancellationBy,
  reason?:       string,
): Promise<ServiceResponse<{ message: string; refund_eligible: boolean }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (cancelledBy === CancellationBy.PATIENT && appointment.patient_id !== requesterId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'You can only cancel your own appointments.');
  if (appointment.status === AppointmentStatus.CANCELLED) throw ErrorFactory.conflict('BOOKING_ALREADY_CANCELLED', 'This appointment is already cancelled.');
  if ([AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS].includes(appointment.status)) throw ErrorFactory.unprocessable('BOOKING_CANNOT_CANCEL', 'Cannot cancel a completed or in-progress appointment.');

  // Patients cannot cancel within 2 hours of the appointment time
  if (cancelledBy === CancellationBy.PATIENT) {
    const hoursUntil = (new Date(appointment.scheduled_at).getTime() - Date.now()) / 3_600_000;
    if (hoursUntil < 2) {
      throw ErrorFactory.unprocessable('CANCELLATION_WINDOW_CLOSED',
        'Cancellation is not allowed within 2 hours of your appointment. Contact the hospital directly.');
    }
  }

  // Refund only if payment was captured AND cancellation is outside the REFUND_WINDOW_HOURS
  const hoursUntilAppt  = (new Date(appointment.scheduled_at).getTime() - Date.now()) / (1000 * 60 * 60);
  const pastDeadline    = hoursUntilAppt < env.REFUND_WINDOW_HOURS;
  const refund_eligible = appointment.payment_status === PaymentStatus.CAPTURED && !pastDeadline;

  await sequelize.transaction(async (t) => {
    await appointment.update({
      status:              AppointmentStatus.CANCELLED,
      payment_status:      refund_eligible ? PaymentStatus.REFUND_PENDING : appointment.payment_status,
      cancellation_reason: reason ?? null,
      cancelled_by:        cancelledBy,
      cancelled_at:        new Date(),
    }, { transaction: t });

    if (appointment.slot_id) {
      await OpdSlotSession.update(
        { status: OpdSlotStatus.PUBLISHED, appointment_id: null },
        { where: { id: appointment.slot_id }, transaction: t },
      );
    }
  });

  // Waitlist bridge: offer freed slot to next person on waitlist
  if (appointment.slot_id) {
    await offerSlotToWaitlist(appointment.slot_id, appointment.doctor_id, appointment.scheduled_at);
  }

  const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
  await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, dateStr));

  // Remove patient from consultation queue
  await ConsultationQueue.update(
    { status: QueueStatus.CANCELLED },
    { where: { appointment_id: appointmentId } },
  );
  await invalidateQueueCache(appointment.doctor_id, dateStr);

  // Notify patient
  const cancelDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId: appointment.patient_id,
    appointmentId,
    type: 'booking_cancelled_patient',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority: 'high',
    data: {
      name:   'Patient',
      doctor: cancelDoctor?.full_name ?? 'Doctor',
      date:   appointment.scheduled_at.toDateString(),
      amount: appointment.consultation_fee ?? 0,
    },
  });

  logger.info('Appointment cancelled', { appointmentId, cancelledBy, refund_eligible });
  return ok({ message: 'Appointment cancelled successfully.', refund_eligible });
}

// ── Reschedule appointment ────────────────────────────────────────────────────
export async function rescheduleAppointment(
  appointmentId: string,
  patientId:     string,
  newSlotId:     string,
  reason?:       string,
): Promise<ServiceResponse<object>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.patient_id !== patientId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.');
  if ([AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS].includes(appointment.status)) {
    throw ErrorFactory.unprocessable('BOOKING_CANNOT_RESCHEDULE', 'This appointment cannot be rescheduled.');
  }
  if (appointment.slot_id === newSlotId) {
    throw ErrorFactory.conflict('SAME_SLOT', 'The new slot is the same as the current slot. Please choose a different time.');
  }

  // Validate lead time / cutoff for the new slot before acquiring the lock
  const pref = await DoctorBookingPreference.findOne({ where: { doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id } });
  if (pref) {
    const newSlotForCheck = await OpdSlotSession.findByPk(newSlotId, { attributes: ['date', 'slot_start_time'] });
    if (newSlotForCheck) {
      const now      = new Date();
      const slotTime = new Date(`${newSlotForCheck.date}T${newSlotForCheck.slot_start_time}:00`).getTime();
      if (pref.min_booking_lead_hours > 0 && slotTime - now.getTime() < pref.min_booking_lead_hours * 3_600_000) {
        throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
      }
      if (pref.booking_cutoff_hours > 0 && slotTime - now.getTime() < pref.booking_cutoff_hours * 3_600_000) {
        throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings for this doctor close ${pref.booking_cutoff_hours}h before the slot.`);
      }
    }
  }

  // Lock and validate the new slot
  const lockKey = `lock:slot:${newSlotId}`;
  const lockVal = `${patientId}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot is currently being booked. Please try another.');

  // Capture old date before the transaction mutates scheduled_at
  const oldDate = appointment.scheduled_at.toISOString().split('T')[0];

  try {
    const result = await sequelize.transaction(async (t) => {
      const newSlot = await OpdSlotSession.findOne({
        where: { id: newSlotId, doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!newSlot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'New slot not found.');
      if (newSlot.status !== OpdSlotStatus.PUBLISHED) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      const newSlotDateTime = new Date(`${newSlot.date}T${newSlot.slot_start_time}:00`);
      if (newSlotDateTime < new Date()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot reschedule to a past slot.');

      // Free the old slot
      if (appointment.slot_id) {
        await OpdSlotSession.update(
          { status: OpdSlotStatus.PUBLISHED, appointment_id: null },
          { where: { id: appointment.slot_id }, transaction: t },
        );
      }

      // Book the new slot and update appointment
      await newSlot.update({ status: OpdSlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });
      await appointment.update({
        slot_id:             newSlotId,
        scheduled_at:        newSlotDateTime,
        status:              AppointmentStatus.CONFIRMED,
        cancellation_reason: reason ?? null,
      }, { transaction: t });

      return appointment;
    });

    const newDate = result.scheduled_at.toISOString().split('T')[0];

    // Invalidate slot caches for both dates
    await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, oldDate));
    if (oldDate !== newDate) {
      await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, newDate));
    }

    // Update consultation queue: cancel old entry, add new one
    await ConsultationQueue.update(
      { status: QueueStatus.CANCELLED },
      { where: { appointment_id: appointmentId } },
    );
    await invalidateQueueCache(appointment.doctor_id, oldDate);
    await addToQueue(result.id, appointment.doctor_id, appointment.hospital_id, patientId, result.scheduled_at);

    // Notify patient
    const reschedDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
    await enqueueNotification({
      userId:        patientId,
      appointmentId: result.id,
      type:          'booking_rescheduled',
      channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority:      'high',
      data: {
        name:   'Patient',
        doctor: reschedDoctor?.full_name ?? 'Doctor',
        date:   result.scheduled_at.toDateString(),
        time:   result.scheduled_at.toTimeString().slice(0, 5),
      },
    });

    logger.info('Appointment rescheduled', { appointmentId, newSlotId, patientId });
    return ok({
      appointment_id: result.id,
      status:         result.status,
      scheduled_at:   result.scheduled_at,
    });
  } finally {
    const cur = await redis.get(lockKey);
    if (cur === lockVal) await redis.del(lockKey);
  }
}

// ── Get appointment ───────────────────────────────────────────────────────────
export async function getAppointment(appointmentId: string, requesterId: string): Promise<ServiceResponse<object>> {
  const appointment = await Appointment.findByPk(appointmentId, {
    include: [
      { model: DoctorProfile,    as: 'doctor',    attributes: ['id', 'full_name', 'specialization', 'profile_photo_url'] },
      { model: Hospital,         as: 'hospital',  attributes: ['id', 'name'] },
      { model: OpdSlotSession,   as: 'slot',      attributes: ['slot_start_time', 'slot_end_time', 'date', 'duration_minutes'] },
      { model: OpdToken,         as: 'opdToken',  attributes: ['token_number', 'personalized_duration_minutes'] },
    ],
  });
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.patient_id !== requesterId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.');
  return ok(appointment);
}

// ── Patient appointment history ───────────────────────────────────────────────
export async function getPatientAppointments(patientId: string, page = 1, perPage = 20): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await Appointment.findAndCountAll({
    where:   { patient_id: patientId },
    include: [
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name', 'specialization', 'profile_photo_url'] },
      { model: Hospital,      as: 'hospital', attributes: ['name'] },
    ],
    order:   [['scheduled_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}

// ── Hospital: accept appointment ──────────────────────────────────────────────
export async function acceptAppointment(
  appointmentId: string,
  hospitalId:    string,
): Promise<ServiceResponse<{ message: string }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.hospital_id !== hospitalId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'This appointment does not belong to your hospital.');
  if (appointment.status !== AppointmentStatus.AWAITING_HOSPITAL_APPROVAL) {
    throw ErrorFactory.unprocessable('BOOKING_INVALID_STATUS', 'Only appointments awaiting hospital approval can be accepted.');
  }

  // Cash/card appointments don't need online payment — go straight to CONFIRMED
  const isCashOrCard = appointment.payment_mode === PaymentMode.CASH || appointment.payment_mode === PaymentMode.CARD;
  const newStatus    = isCashOrCard ? AppointmentStatus.CONFIRMED : AppointmentStatus.PENDING;
  await appointment.update({ status: newStatus });

  const doctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId:        appointment.patient_id,
    appointmentId: appointment.id,
    type:          'booking_confirmed',
    channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority:      'high',
    data: {
      name:   'Patient',
      doctor: doctor?.full_name ?? 'Doctor',
      date:   appointment.scheduled_at.toDateString(),
      time:   appointment.scheduled_at.toTimeString().slice(0, 5),
      token:  '—',
    },
  });

  logger.info('Appointment accepted by hospital', { appointmentId, hospitalId, newStatus });
  return ok({ message: 'Appointment accepted successfully.' });
}

// ── Hospital: reject appointment ──────────────────────────────────────────────
export async function rejectAppointment(
  appointmentId: string,
  hospitalId:    string,
  reason?:       string,
): Promise<ServiceResponse<{ message: string; refund_eligible: boolean }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.hospital_id !== hospitalId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'This appointment does not belong to your hospital.');
  if (appointment.status !== AppointmentStatus.AWAITING_HOSPITAL_APPROVAL) {
    throw ErrorFactory.unprocessable('BOOKING_INVALID_STATUS', 'Only appointments awaiting hospital approval can be rejected.');
  }

  const refund_eligible = appointment.payment_status === PaymentStatus.CAPTURED;

  await sequelize.transaction(async (t) => {
    await appointment.update({
      status:              AppointmentStatus.CANCELLED,
      payment_status:      refund_eligible ? PaymentStatus.REFUND_PENDING : appointment.payment_status,
      cancellation_reason: reason ?? null,
      cancelled_by:        CancellationBy.ADMIN,
      cancelled_at:        new Date(),
    }, { transaction: t });

    if (appointment.slot_id) {
      await OpdSlotSession.update(
        { status: OpdSlotStatus.PUBLISHED, appointment_id: null },
        { where: { id: appointment.slot_id }, transaction: t },
      );
    }
  });

  const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
  await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, dateStr));

  // Remove patient from consultation queue
  await ConsultationQueue.update(
    { status: QueueStatus.CANCELLED },
    { where: { appointment_id: appointmentId } },
  );
  await invalidateQueueCache(appointment.doctor_id, dateStr);

  const rejDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId:        appointment.patient_id,
    appointmentId: appointment.id,
    type:          'booking_cancelled_doctor',
    channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority:      'high',
    data: {
      name:   'Patient',
      doctor: rejDoctor?.full_name ?? 'Doctor',
      date:   appointment.scheduled_at.toDateString(),
      amount: appointment.consultation_fee ?? 0,
    },
  });

  logger.info('Appointment rejected by hospital', { appointmentId, hospitalId, refund_eligible });
  return ok({ message: 'Appointment rejected successfully.', refund_eligible });
}

// ── Hospital: list appointments ───────────────────────────────────────────────
export async function getHospitalAppointments(
  hospitalId: string,
  status?:    AppointmentStatus,
  page  = 1,
  perPage = 20,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (status) where['status'] = status;

  const { rows, count } = await Appointment.findAndCountAll({
    where,
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
    order:   [['scheduled_at', 'ASC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}

// ── Waitlist bridge: offer freed slot to next person in FIFO order ────────────
// Called after a slot-mode appointment is cancelled and the slot becomes AVAILABLE again.
async function offerSlotToWaitlist(
  slotId:      string,
  doctorId:    string,
  scheduledAt: Date,
): Promise<void> {
  try {
    const doctor = await DoctorProfile.findByPk(doctorId, {
      attributes: ['waitlist_enabled', 'waitlist_offer_expiry_minutes'],
    });
    if (!doctor?.waitlist_enabled) return;

    const dateStr = scheduledAt.toISOString().split('T')[0];

    const next = await WaitlistEntry.findOne({
      where: { doctor_id: doctorId, date: dateStr, status: WaitlistStatus.WAITING },
      order: [['position', 'ASC']],
    });
    if (!next) return;

    const expiryMinutes = doctor.waitlist_offer_expiry_minutes ?? 30;
    const expiresAt     = new Date(Date.now() + expiryMinutes * 60_000);

    await next.update({
      status:         WaitlistStatus.OFFERED,
      offered_slot_id: slotId,
      offered_at:     new Date(),
      expires_at:     expiresAt,
    });

    await enqueueNotification({
      userId:        next.patient_id,
      appointmentId: undefined,
      type:          'waitlist_slot_offered',
      channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority:      'high',
      data: {
        name:            'Patient',
        date:            dateStr,
        expiry_minutes:  String(expiryMinutes),
      },
    });

    logger.info('Waitlist slot offered', { waitlistEntryId: next.id, slotId, expiresAt });
  } catch (err) {
    logger.warn('Waitlist bridge failed (non-critical)', { slotId, doctorId, err });
  }
}

