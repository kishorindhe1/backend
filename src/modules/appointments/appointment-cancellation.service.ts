import { sequelize }                       from '../../config/database';
import { redis, RedisKeys }               from '../../config/redis';
import {
  OpdSlotSession, OpdSlotStatus,
  Appointment, AppointmentStatus, PaymentStatus,
  PaymentMode, CancellationBy,
  DoctorProfile,
  ConsultationQueue, QueueStatus,
  WaitlistEntry, WaitlistStatus,
}                                          from '../../models';
import { env }                            from '../../config/env';
import { ErrorFactory }                   from '../../utils/errors';
import { ServiceResponse, ok }            from '../../types';
import { logger }                         from '../../utils/logger';
import { invalidateQueueCache }           from '../queue/queue.service';
import { enqueueNotification }            from '../notifications/notification.service';
import { NotificationChannel }            from '../../models';

export async function cancelAppointment(
  appointmentId: string,
  requesterId:   string,
  cancelledBy:   CancellationBy,
  reason?:       string,
): Promise<ServiceResponse<{ message: string; refund_eligible: boolean }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (cancelledBy === CancellationBy.PATIENT && appointment.patient_id !== requesterId)
    throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'You can only cancel your own appointments.');
  if (appointment.status === AppointmentStatus.CANCELLED)
    throw ErrorFactory.conflict('BOOKING_ALREADY_CANCELLED', 'This appointment is already cancelled.');
  if ([AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS].includes(appointment.status))
    throw ErrorFactory.unprocessable('BOOKING_CANNOT_CANCEL', 'Cannot cancel a completed or in-progress appointment.');

  if (cancelledBy === CancellationBy.PATIENT) {
    const hoursUntil = (new Date(appointment.scheduled_at).getTime() - Date.now()) / 3_600_000;
    if (hoursUntil < 2)
      throw ErrorFactory.unprocessable('CANCELLATION_WINDOW_CLOSED', 'Cancellation is not allowed within 2 hours of your appointment. Contact the hospital directly.');
  }

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

  if (appointment.slot_id)
    await offerSlotToWaitlist(appointment.slot_id, appointment.doctor_id, appointment.scheduled_at);

  const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
  await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, dateStr));

  await ConsultationQueue.update({ status: QueueStatus.CANCELLED }, { where: { appointment_id: appointmentId } });
  await invalidateQueueCache(appointment.doctor_id, dateStr);

  const cancelDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId: appointment.patient_id, appointmentId, type: 'booking_cancelled_patient',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
    data: { name: 'Patient', doctor: cancelDoctor?.full_name ?? 'Doctor', date: appointment.scheduled_at.toDateString(), amount: appointment.consultation_fee ?? 0 },
  });

  logger.info('Appointment cancelled', { appointmentId, cancelledBy, refund_eligible });
  return ok({ message: 'Appointment cancelled successfully.', refund_eligible });
}

export async function rejectAppointment(
  appointmentId: string,
  hospitalId:    string,
  reason?:       string,
): Promise<ServiceResponse<{ message: string; refund_eligible: boolean }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.hospital_id !== hospitalId)
    throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'This appointment does not belong to your hospital.');
  if (appointment.status !== AppointmentStatus.AWAITING_HOSPITAL_APPROVAL)
    throw ErrorFactory.unprocessable('BOOKING_INVALID_STATUS', 'Only appointments awaiting hospital approval can be rejected.');

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
  await ConsultationQueue.update({ status: QueueStatus.CANCELLED }, { where: { appointment_id: appointmentId } });
  await invalidateQueueCache(appointment.doctor_id, dateStr);

  const rejDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId: appointment.patient_id, appointmentId, type: 'booking_cancelled_doctor',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
    data: { name: 'Patient', doctor: rejDoctor?.full_name ?? 'Doctor', date: appointment.scheduled_at.toDateString(), amount: appointment.consultation_fee ?? 0 },
  });

  logger.info('Appointment rejected by hospital', { appointmentId, hospitalId, refund_eligible });
  return ok({ message: 'Appointment rejected successfully.', refund_eligible });
}

// ── Waitlist bridge ───────────────────────────────────────────────────────────
async function offerSlotToWaitlist(slotId: string, doctorId: string, scheduledAt: Date): Promise<void> {
  try {
    const doctor = await DoctorProfile.findByPk(doctorId, { attributes: ['waitlist_enabled', 'waitlist_offer_expiry_minutes'] });
    if (!doctor?.waitlist_enabled) return;

    const dateStr    = scheduledAt.toISOString().split('T')[0];
    const next       = await WaitlistEntry.findOne({ where: { doctor_id: doctorId, date: dateStr, status: WaitlistStatus.WAITING }, order: [['position', 'ASC']] });
    if (!next) return;

    const expiryMinutes = doctor.waitlist_offer_expiry_minutes ?? 30;
    const expiresAt     = new Date(Date.now() + expiryMinutes * 60_000);

    await next.update({ status: WaitlistStatus.OFFERED, offered_slot_id: slotId, offered_at: new Date(), expires_at: expiresAt });

    await enqueueNotification({
      userId: next.patient_id, appointmentId: undefined, type: 'waitlist_slot_offered',
      channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: { name: 'Patient', date: dateStr, expiry_minutes: String(expiryMinutes) },
    });

    logger.info('Waitlist slot offered', { waitlistEntryId: next.id, slotId, expiresAt });
  } catch (err) {
    logger.warn('Waitlist bridge failed (non-critical)', { slotId, doctorId, err });
  }
}
