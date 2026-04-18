import { Op }                             from 'sequelize';
import {
  ConsultationQueue, QueueStatus,
  Appointment, AppointmentStatus,
  OpdSlotSession, OpdSlotStatus,
  DoctorDelayEvent, DelayStatus, DelayType,
  GeneratedSlot, SlotStatus,
  DoctorHospitalAffiliation,
  Schedule, DayOfWeek,
}                                          from '../../models';
import { ServiceResponse, ok, fail }       from '../../types';
import { ErrorFactory }                    from '../../utils/errors';
import { logger }                          from '../../utils/logger';
import { invalidateQueueCache }            from '../queue/queue.service';
import { enqueueNotification }             from '../notifications/notification.service';
import { NotificationChannel }             from '../../models';

const JS_DAY_TO_ENUM: DayOfWeek[] = [
  DayOfWeek.SUNDAY, DayOfWeek.MONDAY, DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY,
];

// ── Mark consultation done ────────────────────────────────────────────────────

export async function markConsultationDone(
  appointmentId: string,
  doctorId:       string,
): Promise<ServiceResponse<{ duration_minutes: number }>> {
  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) return fail('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.', 404);
  if (entry.doctor_id !== doctorId) return fail('FORBIDDEN', 'Not your patient.', 403);
  if (entry.status === QueueStatus.COMPLETED) return fail('ALREADY_DONE', 'Consultation already marked done.', 409);

  const now = new Date();
  await entry.update({ status: QueueStatus.COMPLETED, actual_end_at: now });

  await Appointment.update({ status: AppointmentStatus.COMPLETED }, { where: { id: appointmentId } });

  await OpdSlotSession.update(
    { status: OpdSlotStatus.COMPLETED },
    { where: { appointment_id: appointmentId } },
  );

  const durationMin = entry.actual_start_at
    ? Math.round((now.getTime() - entry.actual_start_at.getTime()) / 60_000)
    : 0;

  await invalidateQueueCache(doctorId, entry.queue_date);
  logger.info('Consultation marked done', { appointmentId, doctorId, durationMin });
  return ok({ duration_minutes: durationMin });
}

// ── Self-report delay ─────────────────────────────────────────────────────────

export async function selfReportDelay(
  doctorId:     string,
  hospitalId:   string,
  delayMinutes: number,
  reason?:      string,
): Promise<ServiceResponse<{ delay_event_id: string; patients_notified: number }>> {
  const date = new Date().toISOString().split('T')[0];

  // Resolve any existing active delay first
  await DoctorDelayEvent.update(
    { status: DelayStatus.RESOLVED },
    { where: { doctor_id: doctorId, hospital_id: hospitalId, event_date: date, status: DelayStatus.ACTIVE } },
  );

  const event = await DoctorDelayEvent.create({
    doctor_id:     doctorId,
    hospital_id:   hospitalId,
    event_date:    date,
    delay_type:    DelayType.LATE_ARRIVAL,
    delay_minutes: delayMinutes,
    reason:        reason ?? null,
    status:        DelayStatus.ACTIVE,
    reported_by:   doctorId,
  });

  // Notify all booked patients for the rest of the day
  const bookedAppts = await Appointment.findAll({
    where: {
      doctor_id: doctorId,
      hospital_id: hospitalId,
      status: { [Op.in]: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING] },
      scheduled_at: { [Op.gte]: new Date() },
    },
    attributes: ['id', 'patient_id', 'scheduled_at'],
    limit: 100,
  });

  let notified = 0;
  for (const appt of bookedAppts) {
    try {
      const newTime = new Date(appt.scheduled_at.getTime() + delayMinutes * 60_000);
      await enqueueNotification({
        userId:        appt.patient_id,
        appointmentId: appt.id,
        type:          'doctor_delay',
        channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
        priority:      'medium',
        data: {
          name:         'Patient',
          delay_minutes: String(delayMinutes),
          new_time:     newTime.toTimeString().slice(0, 5),
        },
      });
      notified++;
    } catch { /* non-critical */ }
  }

  await invalidateQueueCache(doctorId, date);
  logger.info('Doctor self-reported delay', { doctorId, delayMinutes, notified });
  return ok({ delay_event_id: event.id, patients_notified: notified });
}

// ── Self check-in ─────────────────────────────────────────────────────────────

export async function selfCheckIn(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<{ checked_in_at: string }>> {
  const date = new Date().toISOString().split('T')[0];

  await DoctorDelayEvent.update(
    { status: DelayStatus.RESOLVED, actual_arrival: new Date() },
    { where: { doctor_id: doctorId, hospital_id: hospitalId, event_date: date, status: DelayStatus.ACTIVE } },
  );

  await invalidateQueueCache(doctorId, date);
  return ok({ checked_in_at: new Date().toISOString() });
}

// ── Get own queue for today ───────────────────────────────────────────────────

export async function getDoctorOwnQueue(
  doctorId:   string,
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<object[]>> {
  const entries = await ConsultationQueue.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, queue_date: date },
    order: [['queue_position', 'ASC']],
    include: [
      { association: 'appointment', attributes: ['id', 'patient_id', 'scheduled_at', 'status', 'appointment_type', 'notes'] },
    ],
  });
  return ok(entries.map((e) => e.toJSON()));
}

// ── Reserve follow-up slot ────────────────────────────────────────────────────

export async function reserveFollowUpSlot(input: {
  doctorId:        string;
  hospitalId:      string;
  patientId:       string;
  date:            string;
  preferredTime?:  string;
}): Promise<ServiceResponse<{ slot_id: string; slot_start_time: string; date: string }>> {
  const { doctorId, hospitalId, patientId, date, preferredTime } = input;

  // Find a PUBLISHED slot that is still available
  const whereClause: Record<string, unknown> = {
    doctor_id:   doctorId,
    hospital_id: hospitalId,
    date,
    status:      OpdSlotStatus.PUBLISHED,
  };
  if (preferredTime) whereClause.slot_start_time = { [Op.gte]: preferredTime };

  const slot = await OpdSlotSession.findOne({
    where: whereClause,
    order: [['slot_start_time', 'ASC']],
  });

  if (!slot) return fail('NO_SLOT_AVAILABLE', 'No available published slots for the requested date.', 409);

  await slot.update({
    status:     OpdSlotStatus.BOOKED,
    slot_category: 'follow_up_only' as any,
  });

  logger.info('Follow-up slot reserved', { doctorId, patientId, date, slotId: slot.id });
  return ok({ slot_id: slot.id, slot_start_time: slot.slot_start_time, date: slot.date });
}

// ── Gap-based timeline view ───────────────────────────────────────────────────

export async function getGapTimeline(
  doctorId:   string,
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<object[]>> {
  const sessions = await OpdSlotSession.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      date,
    },
    order: [['slot_start_time', 'ASC']],
    attributes: ['id', 'slot_start_time', 'slot_end_time', 'duration_minutes', 'status', 'booking_engine', 'procedure_type_id', 'appointment_id'],
  });

  return ok(sessions.map((s) => ({
    ...s.toJSON(),
    label: `${s.slot_start_time}–${s.slot_end_time}`,
  })));
}
