import { sequelize }                     from '../../config/database';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import {
  GeneratedSlot, SlotStatus,
  OpdSlotSession, OpdSlotStatus,
  Appointment, AppointmentStatus, PaymentStatus,
  AppointmentType, PaymentMode, CancellationBy,
  DoctorProfile,
  DoctorHospitalAffiliation,
  Hospital, AppointmentApprovalMode, PaymentCollectionMode,
  OpdToken,
  DoctorBookingPreference,
}                                         from '../../models';
import { env }                           from '../../config/env';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok, fail }     from '../../types';
import { logger }                        from '../../utils/logger';
import { incrementCounter } from '../admin/admin.service';
import { addToQueue }                    from '../queue/queue.service';
import { enqueueNotification }           from '../notifications/notification.service';
import { NotificationChannel }           from '../../models';

// ── Phase 3: sync OpdSlotSession status to mirror GeneratedSlot state ────────
// Best-effort — logs on failure, never throws. Matches by scheduled_at time → slot_start_time.
async function syncOpdSlotStatus(
  doctorId:    string,
  hospitalId:  string,
  dateStr:     string,
  scheduledAt: Date,
  toStatus:    OpdSlotStatus,
  appointmentId: string | null,
): Promise<void> {
  try {
    const hhmm = `${String(scheduledAt.getHours()).padStart(2, '0')}:${String(scheduledAt.getMinutes()).padStart(2, '0')}`;
    const updates: Record<string, unknown> = { status: toStatus };
    if (toStatus === OpdSlotStatus.BOOKED) updates.appointment_id = appointmentId;
    if (toStatus === OpdSlotStatus.PUBLISHED) updates.appointment_id = null;

    await OpdSlotSession.update(updates, {
      where: { doctor_id: doctorId, hospital_id: hospitalId, date: dateStr, slot_start_time: hhmm },
    });
  } catch (err) {
    logger.warn('Phase3: syncOpdSlotStatus failed (non-critical)', { doctorId, hospitalId, dateStr, toStatus, err });
  }
}

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
  slot_id:           string;
  notes?:            string;
  appointment_type?: AppointmentType;
  payment_mode?:     PaymentMode; // only honoured when hospital.payment_collection_mode = 'patient_choice'
}

export async function bookAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  const { patient_id, doctor_id, hospital_id, slot_id, notes } = input;

  // Layer 1 — Redis distributed lock
  const lockKey = `lock:slot:${slot_id}`;
  const lockVal = `${patient_id}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot is currently being booked. Please try another.');

  try {
    // Check hospital settings before the transaction
    const hospital = await Hospital.findByPk(hospital_id, { attributes: ['appointment_approval', 'payment_collection_mode'] });
    if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');
    const isAutoApproval = hospital.appointment_approval === AppointmentApprovalMode.AUTO;

    // ── Doctor booking preference checks ──────────────────────────────────────
    const pref = await DoctorBookingPreference.findOne({ where: { doctor_id, hospital_id } });
    if (pref) {
      const now = new Date();

      // min_booking_lead_hours — slot must be at least N hours in the future
      if (pref.min_booking_lead_hours > 0) {
        const slot = await GeneratedSlot.findByPk(slot_id, { attributes: ['slot_datetime'] });
        if (slot) {
          const leadMs = pref.min_booking_lead_hours * 60 * 60 * 1000;
          if (slot.slot_datetime.getTime() - now.getTime() < leadMs) {
            throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
          }
        }
      }

      // booking_cutoff_hours — no bookings within N hours of slot time
      if (pref.booking_cutoff_hours > 0) {
        const slot = await GeneratedSlot.findByPk(slot_id, { attributes: ['slot_datetime'] });
        if (slot) {
          const cutoffMs = pref.booking_cutoff_hours * 60 * 60 * 1000;
          if (slot.slot_datetime.getTime() - now.getTime() < cutoffMs) {
            throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings for this doctor close ${pref.booking_cutoff_hours}h before the slot.`);
          }
        }
      }

      // max_new_patients_per_day — count confirmed/pending appointments for the day
      if (pref.max_new_patients_per_day != null && input.appointment_type !== AppointmentType.FOLLOW_UP) {
        const Op = (await import('sequelize')).Op;
        const slotForDate = await GeneratedSlot.findByPk(slot_id, { attributes: ['slot_datetime'] });
        if (slotForDate) {
          const dateStr = slotForDate.slot_datetime.toISOString().split('T')[0];
          const count = await Appointment.count({
            where: {
              doctor_id,
              hospital_id,
              appointment_type: { [Op.ne]: AppointmentType.FOLLOW_UP },
              status: { [Op.in]: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL] },
              scheduled_at: { [Op.between]: [new Date(`${dateStr}T00:00:00`), new Date(`${dateStr}T23:59:59`)] },
            },
          });
          if (count >= pref.max_new_patients_per_day) {
            throw ErrorFactory.conflict('DAILY_NEW_PATIENT_LIMIT', 'Daily new patient limit reached for this doctor.');
          }
        }
      }

      // max_followups_per_day
      if (pref.max_followups_per_day != null && input.appointment_type === AppointmentType.FOLLOW_UP) {
        const Op = (await import('sequelize')).Op;
        const slotForDate = await GeneratedSlot.findByPk(slot_id, { attributes: ['slot_datetime'] });
        if (slotForDate) {
          const dateStr = slotForDate.slot_datetime.toISOString().split('T')[0];
          const count = await Appointment.count({
            where: {
              doctor_id,
              hospital_id,
              appointment_type: AppointmentType.FOLLOW_UP,
              status: { [Op.in]: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL] },
              scheduled_at: { [Op.between]: [new Date(`${dateStr}T00:00:00`), new Date(`${dateStr}T23:59:59`)] },
            },
          });
          if (count >= pref.max_followups_per_day) {
            throw ErrorFactory.conflict('DAILY_FOLLOWUP_LIMIT', 'Daily follow-up limit reached for this doctor.');
          }
        }
      }
    }
    // ── End preference checks ─────────────────────────────────────────────────

    // Resolve payment mode: patient_choice lets patient pick; otherwise force online_prepaid
    const isPatientChoice = hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE;
    const resolvedPaymentMode = isPatientChoice && input.payment_mode
      ? input.payment_mode
      : PaymentMode.ONLINE_PREPAID;

    const result = await sequelize.transaction(async (t) => {
      // Layer 2 — SELECT FOR UPDATE
      const slot = await GeneratedSlot.findOne({
        where: { id: slot_id, doctor_id, hospital_id },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!slot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'Slot not found.');
      if (slot.status !== SlotStatus.AVAILABLE) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      if (slot.slot_datetime < new Date()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot book a past slot.');

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

      // Layer 3 — unique slot_id constraint catches any slip-through
      const appointment = await Appointment.create({
        patient_id, doctor_id, hospital_id, slot_id,
        scheduled_at:     slot.slot_datetime,
        status:           initialStatus,
        payment_status:   isCashOrCard ? PaymentStatus.PENDING : PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode:     resolvedPaymentMode,
        consultation_fee: fee,
        platform_fee:     splits.platform_fee,
        doctor_payout:    splits.doctor_payout,
        notes:            notes ?? null,
        cancellation_reason: null, cancelled_by: null, cancelled_at: null,
        razorpay_order_id: null,
      }, { transaction: t });

      await slot.update({ status: SlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });
      return appointment;
    });

    // Invalidate slot cache
    const dateStr = result.scheduled_at.toISOString().split('T')[0];
    await redis.del(RedisKeys.availableSlots(doctor_id, dateStr));
    await redis.del(RedisKeys.publishedSlots(doctor_id, dateStr));

    // Phase 3: sync OpdSlotSession to BOOKED (best-effort)
    await syncOpdSlotStatus(doctor_id, hospital_id, dateStr, result.scheduled_at, OpdSlotStatus.BOOKED, result.id);

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
      await GeneratedSlot.update(
        { status: SlotStatus.AVAILABLE, appointment_id: null },
        { where: { id: appointment.slot_id }, transaction: t },
      );
    }
  });

  const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
  await redis.del(RedisKeys.availableSlots(appointment.doctor_id, dateStr));
  await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, dateStr));

  // Phase 3: sync OpdSlotSession back to PUBLISHED (best-effort)
  await syncOpdSlotStatus(appointment.doctor_id, appointment.hospital_id, dateStr, appointment.scheduled_at, OpdSlotStatus.PUBLISHED, null);

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

  // Lock and validate the new slot
  const lockKey = `lock:slot:${newSlotId}`;
  const lockVal = `${patientId}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot is currently being booked. Please try another.');

  try {
    const result = await sequelize.transaction(async (t) => {
      const newSlot = await GeneratedSlot.findOne({
        where: { id: newSlotId, doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!newSlot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'New slot not found.');
      if (newSlot.status !== SlotStatus.AVAILABLE) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      if (newSlot.slot_datetime < new Date()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot reschedule to a past slot.');

      // Free the old slot
      if (appointment.slot_id) {
        await GeneratedSlot.update(
          { status: SlotStatus.AVAILABLE, appointment_id: null },
          { where: { id: appointment.slot_id }, transaction: t },
        );
      }

      // Book the new slot and update appointment
      await newSlot.update({ status: SlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });
      await appointment.update({
        slot_id:              newSlotId,
        scheduled_at:         newSlot.slot_datetime,
        status:               AppointmentStatus.RESCHEDULED,
        cancellation_reason:  reason ?? null,
      }, { transaction: t });

      return appointment;
    });

    // Invalidate slot caches for both dates
    const oldDate = appointment.scheduled_at.toISOString().split('T')[0];
    const newDate = result.scheduled_at.toISOString().split('T')[0];
    await redis.del(RedisKeys.availableSlots(appointment.doctor_id, oldDate));
    await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, oldDate));
    if (oldDate !== newDate) {
      await redis.del(RedisKeys.availableSlots(appointment.doctor_id, newDate));
      await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, newDate));
    }

    // Phase 3: sync OpdSlotSession — free old, book new (best-effort)
    await syncOpdSlotStatus(appointment.doctor_id, appointment.hospital_id, oldDate, appointment.scheduled_at, OpdSlotStatus.PUBLISHED, null);
    await syncOpdSlotStatus(appointment.doctor_id, appointment.hospital_id, newDate, result.scheduled_at, OpdSlotStatus.BOOKED, result.id);

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
      { model: DoctorProfile, as: 'doctor', attributes: ['id', 'full_name', 'specialization'] },
      { model: Hospital,      as: 'hospital', attributes: ['id', 'name'] },
      { model: GeneratedSlot, as: 'slot',     attributes: ['slot_datetime'] },
      { model: OpdToken,      as: 'opdToken', attributes: ['token_number'] },
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
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name', 'specialization'] },
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

  await appointment.update({ status: AppointmentStatus.PENDING });

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

  logger.info('Appointment accepted by hospital', { appointmentId, hospitalId });
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
      await GeneratedSlot.update(
        { status: SlotStatus.AVAILABLE, appointment_id: null },
        { where: { id: appointment.slot_id }, transaction: t },
      );
    }
  });

  const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
  await redis.del(RedisKeys.availableSlots(appointment.doctor_id, dateStr));

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
