import { Op }                             from 'sequelize';
import { sequelize }                     from '../../config/database';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import { withLock }                      from '../../config/redlock';
import {
  OpdSlotSession, OpdSlotStatus,
  OpdSession, OpdSessionStatus, OpdBookingMode,
  Appointment, AppointmentStatus, PaymentStatus,
  AppointmentType, PaymentMode,
  DoctorProfile,
  DoctorHospitalAffiliation,
  Hospital, AppointmentApprovalMode, PaymentCollectionMode,
  OpdToken, OpdTokenType, OpdTokenStatus,
  DoctorBookingPreference,
}                                         from '../../models';
import { env }                           from '../../config/env';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok }           from '../../types';
import { logger }                        from '../../utils/logger';
import { incrementCounter }              from '../admin/admin.service';
import { addToQueue }                    from '../queue/queue.service';
import { enqueueNotification }           from '../notifications/notification.service';
import { NotificationChannel }           from '../../models';
import { istDateTime }                   from '../../utils/dateTime';
import { encryptField }                  from '../../utils/encryption';

export interface BookAppointmentInput {
  patient_id:        string;
  doctor_id:         string;
  hospital_id:       string;
  slot_id?:          string;
  session_id?:       string;
  notes?:            string;
  appointment_type?: AppointmentType;
  payment_mode?:     PaymentMode;
}

function calcFee(amount: number) {
  const platform_fee  = Math.round(amount * (env.PLATFORM_FEE_PERCENTAGE / 100) * 100) / 100;
  const doctor_payout = amount - platform_fee;
  return { platform_fee, doctor_payout };
}

// ── Queue-based (token mode) booking ─────────────────────────────────────────
async function bookQueueAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  const { patient_id, doctor_id, hospital_id, session_id, notes } = input;

  return withLock(`lock:opd:session:${session_id}`, 10_000, async () => {
    const session = await OpdSession.findByPk(session_id!);
    if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Queue session not found.');
    if (session.booking_mode !== OpdBookingMode.TOKEN_BASED)
      throw ErrorFactory.unprocessable('NOT_QUEUE_SESSION', 'This session does not use queue-based booking.');
    if (![OpdSessionStatus.SCHEDULED, OpdSessionStatus.ACTIVE].includes(session.status as OpdSessionStatus))
      throw ErrorFactory.unprocessable('SESSION_UNAVAILABLE', `Session is ${session.status} and not accepting bookings.`);
    if (session.tokens_issued >= session.total_tokens)
      throw ErrorFactory.conflict('SESSION_FULL', 'This session is fully booked.');

    const existingToken = await OpdToken.findOne({
      where: { session_id: session_id!, patient_id, status: { [Op.notIn]: [OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW] } },
    });
    if (existingToken)
      throw ErrorFactory.conflict('ALREADY_IN_QUEUE', `You already have token #${existingToken.token_number} in this session.`);

    const hospital = await Hospital.findByPk(hospital_id, { attributes: ['appointment_approval', 'payment_collection_mode'] });
    if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');
    const isAutoApproval = hospital.appointment_approval === AppointmentApprovalMode.AUTO;

    const pref = await DoctorBookingPreference.findOne({ where: { doctor_id, hospital_id } });
    if (pref && session.status === OpdSessionStatus.SCHEDULED) {
      const [sy, sm, sd] = session.session_date.split('-').map(Number);
      const [sh, smin]   = session.start_time.split(':').map(Number);
      const slotTime     = new Date(sy, sm - 1, sd, sh, smin, 0, 0).getTime();
      const now          = Date.now();
      if (pref.min_booking_lead_hours > 0 && slotTime - now < pref.min_booking_lead_hours * 3_600_000)
        throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
      if (pref.booking_cutoff_hours > 0 && slotTime - now < pref.booking_cutoff_hours * 3_600_000)
        throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings close ${pref.booking_cutoff_hours}h before the session.`);
    }

    let resolvedPaymentMode: PaymentMode;
    if (hospital.payment_collection_mode === PaymentCollectionMode.CASH_ONLY) resolvedPaymentMode = PaymentMode.CASH;
    else if (hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE && input.payment_mode) resolvedPaymentMode = input.payment_mode;
    else resolvedPaymentMode = PaymentMode.ONLINE_PREPAID;

    const scheduledAt = new Date();

    const { appointment, tokenNumber } = await sequelize.transaction(async (t) => {
      const locked = await OpdSession.findOne({ where: { id: session_id! }, lock: t.LOCK.UPDATE, transaction: t });
      if (!locked || locked.tokens_issued >= locked.total_tokens)
        throw ErrorFactory.conflict('SESSION_FULL', 'Session just filled up. Please try another session.');

      const affiliation = await DoctorHospitalAffiliation.findOne({ where: { doctor_id, hospital_id, is_active: true }, transaction: t });
      if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.');

      const fee    = Number(affiliation.consultation_fee);
      const splits = calcFee(fee);

      const isCashOrCard = resolvedPaymentMode === PaymentMode.CASH || resolvedPaymentMode === PaymentMode.CARD;
      const doctorNeedsApproval = pref?.requires_booking_approval === true;
      let initialStatus: AppointmentStatus;
      if (!isAutoApproval || doctorNeedsApproval) initialStatus = AppointmentStatus.AWAITING_HOSPITAL_APPROVAL;
      else if (isCashOrCard)                      initialStatus = AppointmentStatus.CONFIRMED;
      else                                        initialStatus = AppointmentStatus.PENDING;

      const appt = await Appointment.create({
        patient_id, doctor_id, hospital_id, slot_id: null,
        scheduled_at: scheduledAt, status: initialStatus,
        payment_status: PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode: resolvedPaymentMode,
        consultation_fee: fee, platform_fee: splits.platform_fee, doctor_payout: splits.doctor_payout,
        notes: encryptField(notes),
        cancellation_reason: null, cancelled_by: null, cancelled_at: null, razorpay_order_id: null,
      }, { transaction: t });

      const maxToken    = (await OpdToken.max('token_number', { where: { session_id: session_id! }, transaction: t }) as number | null) ?? 0;
      const newTokenNum = maxToken + 1;
      await OpdToken.create({
        session_id: session_id!, token_number: newTokenNum, patient_id,
        appointment_id: appt.id, token_type: OpdTokenType.ONLINE, issued_by: 'online_booking',
        arrived_at: null, called_at: null, consultation_start: null, consultation_end: null,
        status: OpdTokenStatus.ISSUED, personalized_duration_minutes: null, duration_override: null,
      }, { transaction: t });

      await locked.update({ tokens_issued: locked.tokens_issued + 1 }, { transaction: t });
      return { appointment: appt, tokenNumber: newTokenNum };
    });

    await addToQueue(appointment.id, doctor_id, hospital_id, patient_id, scheduledAt);

    const doctor = await DoctorProfile.findByPk(doctor_id, { attributes: ['full_name'] });
    const pendingAhead   = Math.max(0, session.tokens_issued - session.current_token);
    const estimatedWait  = pendingAhead * Number(session.avg_time_per_patient);

    await enqueueNotification({
      userId: patient_id, appointmentId: appointment.id,
      type: isAutoApproval ? 'booking_confirmed' : 'booking_awaiting_approval',
      channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: { name: 'Patient', doctor: doctor?.full_name ?? 'Doctor', date: scheduledAt.toDateString(), time: session.start_time, token: String(tokenNumber) },
    });

    await incrementCounter('bookings');
    logger.info('Queue appointment booked', { appointmentId: appointment.id, patientId: patient_id, tokenNumber });

    return ok({
      appointment_id: appointment.id, status: appointment.status, payment_status: appointment.payment_status,
      scheduled_at: appointment.scheduled_at, consultation_fee: Number(appointment.consultation_fee),
      platform_fee: Number(appointment.platform_fee), doctor_payout: Number(appointment.doctor_payout),
      razorpay_order_id: null, token_number: tokenNumber, session_id: session_id!,
      session_type: session.session_type, estimated_wait_minutes: estimatedWait,
    });
  });
}

// ── Slot-based booking ────────────────────────────────────────────────────────
export async function bookAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  if (input.session_id && !input.slot_id) return bookQueueAppointment(input);

  const { patient_id, doctor_id, hospital_id, slot_id, notes } = input;
  if (!slot_id) throw ErrorFactory.unprocessable('MISSING_SLOT', 'Either slot_id or session_id is required.');

  return withLock(`lock:slot:${slot_id}`, RedisTTL.SLOT_LOCK * 1000, async () => {
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
      if (existingToday) throw ErrorFactory.conflict('DUPLICATE_BOOKING', 'You already have an active booking with this doctor today.');
    }

    const hospital = await Hospital.findByPk(hospital_id, { attributes: ['appointment_approval', 'payment_collection_mode'] });
    if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');
    const isAutoApproval = hospital.appointment_approval === AppointmentApprovalMode.AUTO;

    const pref = await DoctorBookingPreference.findOne({ where: { doctor_id, hospital_id } });
    if (pref) {
      const prefSlot = await OpdSlotSession.findByPk(slot_id, { attributes: ['date', 'slot_start_time'] });
      if (prefSlot) {
        const now      = new Date();
        const slotTime = new Date(`${prefSlot.date}T${prefSlot.slot_start_time}:00+05:30`).getTime();
        if (pref.min_booking_lead_hours > 0 && slotTime - now.getTime() < pref.min_booking_lead_hours * 3_600_000)
          throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
        if (pref.booking_cutoff_hours > 0 && slotTime - now.getTime() < pref.booking_cutoff_hours * 3_600_000)
          throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings for this doctor close ${pref.booking_cutoff_hours}h before the slot.`);
      }
    }

    let resolvedPaymentMode: PaymentMode;
    if (hospital.payment_collection_mode === PaymentCollectionMode.CASH_ONLY) resolvedPaymentMode = PaymentMode.CASH;
    else if (hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE && input.payment_mode) resolvedPaymentMode = input.payment_mode;
    else resolvedPaymentMode = PaymentMode.ONLINE_PREPAID;

    const result = await sequelize.transaction(async (t) => {
      const slot = await OpdSlotSession.findOne({ where: { id: slot_id, doctor_id, hospital_id }, lock: t.LOCK.UPDATE, transaction: t });
      if (!slot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'Slot not found.');
      if (slot.status !== OpdSlotStatus.PUBLISHED) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      if (`${slot.date}T${slot.slot_start_time}:00` < istDateTime()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot book a past slot.');
      const slotDateTime = new Date(`${slot.date}T${slot.slot_start_time}:00+05:30`);

      const affiliation = await DoctorHospitalAffiliation.findOne({ where: { doctor_id, hospital_id, is_active: true }, transaction: t });
      if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.');

      const fee    = Number(affiliation.consultation_fee);
      const splits = calcFee(fee);

      const doctorRequiresApproval = pref?.requires_booking_approval === true;
      const isCashOrCard = resolvedPaymentMode === PaymentMode.CASH || resolvedPaymentMode === PaymentMode.CARD;
      let initialStatus: AppointmentStatus;
      if (!isAutoApproval || doctorRequiresApproval) initialStatus = AppointmentStatus.AWAITING_HOSPITAL_APPROVAL;
      else if (isCashOrCard)                         initialStatus = AppointmentStatus.CONFIRMED;
      else                                           initialStatus = AppointmentStatus.PENDING;

      if (pref) {
        const dayStart    = new Date(`${slot.date}T00:00:00`);
        const dayEnd      = new Date(`${slot.date}T23:59:59`);
        const capStatuses = [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL];

        if (pref.max_new_patients_per_day != null && input.appointment_type !== AppointmentType.FOLLOW_UP) {
          const count = await Appointment.count({ where: { doctor_id, hospital_id, appointment_type: { [Op.ne]: AppointmentType.FOLLOW_UP }, status: { [Op.in]: capStatuses }, scheduled_at: { [Op.between]: [dayStart, dayEnd] } }, transaction: t });
          if (count >= pref.max_new_patients_per_day) throw ErrorFactory.conflict('DAILY_NEW_PATIENT_LIMIT', 'Daily new patient limit reached for this doctor.');
        }
        if (pref.max_followups_per_day != null && input.appointment_type === AppointmentType.FOLLOW_UP) {
          const count = await Appointment.count({ where: { doctor_id, hospital_id, appointment_type: AppointmentType.FOLLOW_UP, status: { [Op.in]: capStatuses }, scheduled_at: { [Op.between]: [dayStart, dayEnd] } }, transaction: t });
          if (count >= pref.max_followups_per_day) throw ErrorFactory.conflict('DAILY_FOLLOWUP_LIMIT', 'Daily follow-up limit reached for this doctor.');
        }
      }

      const appointment = await Appointment.create({
        patient_id, doctor_id, hospital_id, slot_id,
        scheduled_at: slotDateTime, status: initialStatus,
        payment_status: PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode: resolvedPaymentMode,
        consultation_fee: fee, platform_fee: splits.platform_fee, doctor_payout: splits.doctor_payout,
        notes: encryptField(notes),
        cancellation_reason: null, cancelled_by: null, cancelled_at: null, razorpay_order_id: null,
      }, { transaction: t });

      await slot.update({ status: OpdSlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });

      if (slot.session_id) {
        const maxToken = (await OpdToken.max('token_number', { where: { session_id: slot.session_id }, transaction: t }) as number | null) ?? 0;
        await OpdToken.create({
          session_id: slot.session_id, token_number: maxToken + 1,
          patient_id: appointment.patient_id, appointment_id: appointment.id,
          token_type: OpdTokenType.ONLINE, issued_by: 'online_booking', status: OpdTokenStatus.ISSUED,
        }, { transaction: t });
      }

      return appointment;
    });

    const dateStr = result.scheduled_at.toISOString().split('T')[0];
    await redis.del(RedisKeys.publishedSlots(doctor_id, dateStr));
    await addToQueue(result.id, doctor_id, hospital_id, patient_id, result.scheduled_at);

    const doctor  = await DoctorProfile.findByPk(doctor_id, { attributes: ['full_name'] });
    const notifType = isAutoApproval ? 'booking_confirmed' : 'booking_awaiting_approval';
    await enqueueNotification({
      userId: patient_id, appointmentId: result.id, type: notifType,
      channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: { name: 'Patient', doctor: doctor?.full_name ?? 'Doctor', date: result.scheduled_at.toDateString(), time: result.scheduled_at.toTimeString().slice(0, 5), token: '—' },
    });

    await incrementCounter('bookings');
    logger.info('Appointment booked', { appointmentId: result.id, patientId: patient_id, approval_mode: hospital.appointment_approval });

    return ok({
      appointment_id: result.id, status: result.status, payment_status: result.payment_status,
      scheduled_at: result.scheduled_at, consultation_fee: Number(result.consultation_fee),
      platform_fee: Number(result.platform_fee), doctor_payout: Number(result.doctor_payout),
      razorpay_order_id: result.razorpay_order_id,
    });
  });
}
