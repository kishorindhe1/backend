import { sequelize }                     from '../../config/database';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import {
  GeneratedSlot, SlotStatus,
  Appointment, AppointmentStatus, PaymentStatus,
  AppointmentType, PaymentMode, CancellationBy,
  DoctorProfile,
  DoctorHospitalAffiliation,
}                                         from '../../models';
import { env }                           from '../../config/env';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok, fail }     from '../../types';
import { logger }                        from '../../utils/logger';
import { incrementCounter } from '../admin/admin.service';
import { addToQueue }                    from '../queue/queue.service';
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
  slot_id:           string;
  notes?:            string;
  appointment_type?: AppointmentType;
}

export async function bookAppointment(input: BookAppointmentInput): Promise<ServiceResponse<object>> {
  const { patient_id, doctor_id, hospital_id, slot_id, notes } = input;

  // Layer 1 — Redis distributed lock
  const lockKey = `lock:slot:${slot_id}`;
  const lockVal = `${patient_id}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot is currently being booked. Please try another.');

  try {
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

      // Layer 3 — unique slot_id constraint catches any slip-through
      const appointment = await Appointment.create({
        patient_id, doctor_id, hospital_id, slot_id,
        scheduled_at:     slot.slot_datetime,
        status:           AppointmentStatus.PENDING,
        payment_status:   PaymentStatus.PENDING,
        appointment_type: input.appointment_type ?? AppointmentType.ONLINE_BOOKING,
        payment_mode:     PaymentMode.ONLINE_PREPAID,
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

    // Add to consultation queue
    await addToQueue(result.id, doctor_id, hospital_id, patient_id, result.scheduled_at);

    // Fetch doctor name for notification
    const doctor = await DoctorProfile.findByPk(doctor_id, { attributes: ['full_name'] });

    // Enqueue booking confirmation notification
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

    await incrementCounter('bookings');
    logger.info('Appointment booked', { appointmentId: result.id, patientId: patient_id });

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

  const refund_eligible = appointment.payment_status === PaymentStatus.CAPTURED;

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

  // Notify patient
  await enqueueNotification({
    userId: appointment.patient_id,
    appointmentId,
    type: 'booking_cancelled_patient',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority: 'high',
    data: { name: 'Patient', doctor: 'Doctor', date: appointment.scheduled_at.toDateString() },
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
    if (oldDate !== newDate) await redis.del(RedisKeys.availableSlots(appointment.doctor_id, newDate));

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
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
  });
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.patient_id !== requesterId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.');
  return ok(appointment);
}

// ── Patient appointment history ───────────────────────────────────────────────
export async function getPatientAppointments(patientId: string, page = 1, perPage = 20): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await Appointment.findAndCountAll({
    where:   { patient_id: patientId },
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
    order:   [['scheduled_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}
