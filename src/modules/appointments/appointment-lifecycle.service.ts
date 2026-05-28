import {
  OpdSlotSession, OpdSlotStatus,
  OpdSession, OpdSessionStatus, OpdBookingMode,
  Appointment, AppointmentStatus, PaymentStatus,
  PaymentMode,
  DoctorProfile,
  DoctorHospitalAffiliation, DoctorBookingPreference,
  OpdToken, OpdTokenType, OpdTokenStatus,
  ConsultationQueue, QueueStatus,
}                                         from '../../models';
import { sequelize }                     from '../../config/database';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import { Op }                            from 'sequelize';
import { withLock }                      from '../../config/redlock';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok }           from '../../types';
import { logger }                        from '../../utils/logger';
import { addToQueue, invalidateQueueCache } from '../queue/queue.service';
import { enqueueNotification }           from '../notifications/notification.service';
import { NotificationChannel }           from '../../models';
import { istDateTime }                   from '../../utils/dateTime';

export async function rescheduleAppointment(
  appointmentId: string,
  patientId:     string,
  newSlotId:     string,
  reason?:       string,
): Promise<ServiceResponse<object>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.patient_id !== patientId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.');
  if ([AppointmentStatus.CANCELLED, AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS].includes(appointment.status))
    throw ErrorFactory.unprocessable('BOOKING_CANNOT_RESCHEDULE', 'This appointment cannot be rescheduled.');
  if (appointment.slot_id === newSlotId)
    throw ErrorFactory.conflict('SAME_SLOT', 'The new slot is the same as the current slot. Please choose a different time.');

  const pref = await DoctorBookingPreference.findOne({ where: { doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id } });
  if (pref) {
    const newSlotForCheck = await OpdSlotSession.findByPk(newSlotId, { attributes: ['date', 'slot_start_time'] });
    if (newSlotForCheck) {
      const now      = new Date();
      const slotTime = new Date(`${newSlotForCheck.date}T${newSlotForCheck.slot_start_time}:00+05:30`).getTime();
      if (pref.min_booking_lead_hours > 0 && slotTime - now.getTime() < pref.min_booking_lead_hours * 3_600_000)
        throw ErrorFactory.unprocessable('BOOKING_TOO_LATE', `This doctor requires at least ${pref.min_booking_lead_hours}h advance booking.`);
      if (pref.booking_cutoff_hours > 0 && slotTime - now.getTime() < pref.booking_cutoff_hours * 3_600_000)
        throw ErrorFactory.unprocessable('BOOKING_PAST_CUTOFF', `Bookings for this doctor close ${pref.booking_cutoff_hours}h before the slot.`);
    }
  }

  const oldDate = appointment.scheduled_at.toISOString().split('T')[0];

  return withLock(`lock:slot:${newSlotId}`, RedisTTL.SLOT_LOCK * 1000, async () => {
    const result = await sequelize.transaction(async (t) => {
      const newSlot = await OpdSlotSession.findOne({
        where: { id: newSlotId, doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id },
        lock: t.LOCK.UPDATE, transaction: t,
      });
      if (!newSlot) throw ErrorFactory.notFound('SLOT_NOT_FOUND', 'New slot not found.');
      if (newSlot.status !== OpdSlotStatus.PUBLISHED) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This slot has already been booked.');
      if (`${newSlot.date}T${newSlot.slot_start_time}:00` < istDateTime()) throw ErrorFactory.unprocessable('SLOT_IN_PAST', 'Cannot reschedule to a past slot.');
      const newSlotDateTime = new Date(`${newSlot.date}T${newSlot.slot_start_time}:00+05:30`);

      if (appointment.slot_id) {
        await OpdSlotSession.update({ status: OpdSlotStatus.PUBLISHED, appointment_id: null }, { where: { id: appointment.slot_id }, transaction: t });
      }
      await newSlot.update({ status: OpdSlotStatus.BOOKED, appointment_id: appointment.id }, { transaction: t });
      await appointment.update({ slot_id: newSlotId, scheduled_at: newSlotDateTime, status: AppointmentStatus.CONFIRMED, cancellation_reason: reason ?? null }, { transaction: t });

      return appointment;
    });

    const newDate = result.scheduled_at.toISOString().split('T')[0];
    await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, oldDate));
    if (oldDate !== newDate) await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, newDate));

    await ConsultationQueue.update({ status: QueueStatus.CANCELLED }, { where: { appointment_id: appointmentId } });
    await invalidateQueueCache(appointment.doctor_id, oldDate);
    await addToQueue(result.id, appointment.doctor_id, appointment.hospital_id, patientId, result.scheduled_at);

    const reschedDoctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
    await enqueueNotification({
      userId: patientId, appointmentId: result.id, type: 'booking_rescheduled',
      channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: { name: 'Patient', doctor: reschedDoctor?.full_name ?? 'Doctor', date: result.scheduled_at.toDateString(), time: result.scheduled_at.toTimeString().slice(0, 5) },
    });

    logger.info('Appointment rescheduled', { appointmentId, newSlotId, patientId });
    return ok({ appointment_id: result.id, status: result.status, scheduled_at: result.scheduled_at });
  });
}

export async function acceptAppointment(
  appointmentId: string,
  hospitalId:    string,
): Promise<ServiceResponse<{ message: string }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.hospital_id !== hospitalId)
    throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'This appointment does not belong to your hospital.');
  if (appointment.status !== AppointmentStatus.AWAITING_HOSPITAL_APPROVAL)
    throw ErrorFactory.unprocessable('BOOKING_INVALID_STATUS', 'Only appointments awaiting hospital approval can be accepted.');

  const isCashOrCard = appointment.payment_mode === PaymentMode.CASH || appointment.payment_mode === PaymentMode.CARD;
  const newStatus    = isCashOrCard ? AppointmentStatus.CONFIRMED : AppointmentStatus.PENDING;
  await appointment.update({ status: newStatus });

  let tokenNumber: number | null = null;
  const existingToken = await OpdToken.findOne({ where: { appointment_id: appointmentId } });
  if (!existingToken) {
    const dateStr = appointment.scheduled_at.toISOString().split('T')[0];
    const session = await OpdSession.findOne({
      where: {
        doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id, session_date: dateStr,
        booking_mode: OpdBookingMode.TOKEN_BASED,
        status: { [Op.in]: [OpdSessionStatus.SCHEDULED, OpdSessionStatus.ACTIVE] },
      },
      order: [['start_time', 'ASC']],
    });
    if (session) {
      const lockKey = `lock:opd:session:${session.id}`;
      const acquired = await redis.set(lockKey, appointmentId, 'EX', 10, 'NX');
      if (acquired) {
        try {
          const maxTok = (await OpdToken.max('token_number', { where: { session_id: session.id } }) as number | null) ?? 0;
          tokenNumber  = maxTok + 1;
          await OpdToken.create({
            session_id: session.id, token_number: tokenNumber,
            patient_id: appointment.patient_id, appointment_id: appointmentId,
            token_type: OpdTokenType.ONLINE, issued_by: 'hospital_approval', status: OpdTokenStatus.ISSUED,
          });
          await session.update({ tokens_issued: session.tokens_issued + 1 });
        } finally {
          await redis.del(lockKey);
        }
      }
    }
  } else {
    tokenNumber = existingToken.token_number;
  }

  const doctor = await DoctorProfile.findByPk(appointment.doctor_id, { attributes: ['full_name'] });
  await enqueueNotification({
    userId: appointment.patient_id, appointmentId: appointment.id, type: 'booking_confirmed',
    channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
    data: { name: 'Patient', doctor: doctor?.full_name ?? 'Doctor', date: appointment.scheduled_at.toDateString(), time: appointment.scheduled_at.toTimeString().slice(0, 5), token: tokenNumber ? String(tokenNumber) : '—' },
  });

  logger.info('Appointment accepted by hospital', { appointmentId, hospitalId, newStatus, tokenNumber });
  return ok({ message: 'Appointment accepted successfully.', token_number: tokenNumber });
}
