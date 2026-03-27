import { Op }                          from 'sequelize';
import { redis, RedisKeys, RedisTTL }  from '../../config/redis';
import {
  ConsultationQueue, QueueStatus,
  Appointment, AppointmentStatus,
  DoctorProfile, Hospital,
  DoctorDelayEvent, DelayStatus,
  UserNotificationPreference,
  User, PatientProfile,
}                                       from '../../models';
import { ServiceResponse, ok, fail }    from '../../types';
import { logger }                       from '../../utils/logger';

export interface QueueStateResult {
  appointment_id:           string;
  scheduled_at:             Date;
  queue_position:           number;
  patients_ahead:           number;
  current_delay_minutes:    number;
  estimated_start_at:       Date;
  estimated_wait_minutes:   number;
  doctor_status:            string;
  current_serving:          number;
  avg_consultation_minutes: number;
  your_status:              QueueStatus;
  arrived_at_clinic:        boolean;
  can_cancel:               boolean;
  cancel_refund_percentage: number;
}

export async function getQueueStatus(
  appointmentId: string,
  patientId:     string,
): Promise<ServiceResponse<QueueStateResult>> {
  const cached = await redis.get(`queue:status:${appointmentId}`);
  if (cached) return ok(JSON.parse(cached) as QueueStateResult);

  const entry = await ConsultationQueue.findOne({
    where: { appointment_id: appointmentId },
    include: [{ model: Appointment, as: 'appointment' }],
  });
  if (!entry) return fail('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.', 404);

  const appt = (entry as unknown as { appointment: Appointment }).appointment;
  if (appt.patient_id !== patientId) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.', 403);

  const result = await computeQueueState(entry, appt);
  await redis.setex(`queue:status:${appointmentId}`, 20, JSON.stringify(result));
  return ok(result);
}

async function computeQueueState(entry: ConsultationQueue, appt: Appointment): Promise<QueueStateResult> {
  const { doctor_id, queue_date, queue_position } = entry;

  const delayEvent = await DoctorDelayEvent.findOne({
    where: { doctor_id, event_date: queue_date, status: DelayStatus.ACTIVE },
    order: [['created_at', 'DESC']],
  });

  const currentDelayMinutes = delayEvent?.delay_minutes ?? 0;

  const aheadArrived = await ConsultationQueue.count({
    where: {
      doctor_id, queue_date,
      queue_position: { [Op.lt]: queue_position },
      status: { [Op.in]: [QueueStatus.WAITING, QueueStatus.CALLED, QueueStatus.IN_CONSULTATION] },
      arrived_at: { [Op.ne]: null },
    },
  });

  const aheadNotArrived = await ConsultationQueue.count({
    where: {
      doctor_id, queue_date,
      queue_position: { [Op.lt]: queue_position },
      status: QueueStatus.WAITING,
      arrived_at: null,
    },
  });

  const doctor      = await DoctorProfile.findByPk(doctor_id);
  const noShowRate  = Number(doctor?.no_show_rate_historical ?? 0.25);
  const avgMinutes  = Number(doctor?.avg_consultation_minutes ?? 15);
  const effectiveAhead = Math.round(aheadArrived + (aheadNotArrived * (1 - noShowRate)));
  const breakBuffer    = Math.floor(effectiveAhead / 60) * 5;
  const estimatedWait  = Math.max(0, effectiveAhead * avgMinutes + breakBuffer);

  const inProgress = await ConsultationQueue.findOne({
    where: { doctor_id, queue_date, status: QueueStatus.IN_CONSULTATION },
    order: [['queue_position', 'ASC']],
  });

  const estimatedStartAt = new Date(
    Math.max(appt.scheduled_at.getTime(), Date.now() + estimatedWait * 60_000),
  );

  let refundPct = 0;
  if (currentDelayMinutes >= 31) refundPct = 100;
  else if (currentDelayMinutes >= 16) refundPct = 50;

  const canCancel = ![AppointmentStatus.COMPLETED, AppointmentStatus.IN_PROGRESS, AppointmentStatus.CANCELLED].includes(appt.status);

  return {
    appointment_id:           entry.appointment_id,
    scheduled_at:             appt.scheduled_at,
    queue_position,
    patients_ahead:           effectiveAhead,
    current_delay_minutes:    currentDelayMinutes,
    estimated_start_at:       estimatedStartAt,
    estimated_wait_minutes:   estimatedWait,
    doctor_status:            inProgress ? 'in_consultation' : delayEvent ? 'delayed' : 'available',
    current_serving:          inProgress?.queue_position ?? 0,
    avg_consultation_minutes: avgMinutes,
    your_status:              entry.status,
    arrived_at_clinic:        !!entry.arrived_at,
    can_cancel:               canCancel,
    cancel_refund_percentage: refundPct,
  };
}

export async function getDoctorDayQueue(
  doctorId:   string,
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<object[]>> {
  const entries = await ConsultationQueue.findAll({
    where: { doctor_id: doctorId, queue_date: date },
    include: [{
      model: Appointment,
      as: 'appointment',
      attributes: ['id', 'scheduled_at', 'appointment_type', 'notes'],
      include: [{
        model: User,
        as: 'patient',
        attributes: ['id', 'mobile'],
        include: [{
          model: PatientProfile,
          as: 'patientProfile',
          attributes: ['full_name'],
        }],
      }],
    }],
    order: [['queue_position', 'ASC']],
  });
  return ok(entries);
}

// ── Public display data (no PII — token numbers only) ────────────────────────

export interface QueueDisplayResult {
  doctor:         { full_name: string; specialization: string };
  hospital:       { name: string; city: string };
  current_token:  number | null;
  status:         string;
  next_tokens:    number[];
  total_waiting:  number;
  delay_minutes:  number;
  last_updated:   string;
}

export async function getQueueDisplay(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<QueueDisplayResult>> {
  const cacheKey = `queue:display:${doctorId}:${hospitalId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached) as QueueDisplayResult);

  const date = new Date().toISOString().split('T')[0];

  const [doctor, hospital, entries, delayEvent] = await Promise.all([
    DoctorProfile.findByPk(doctorId, { attributes: ['full_name', 'specialization'] }),
    Hospital.findByPk(hospitalId, { attributes: ['name', 'city'] }),
    ConsultationQueue.findAll({
      where: { doctor_id: doctorId, queue_date: date },
      attributes: ['queue_position', 'status'],
      order: [['queue_position', 'ASC']],
    }),
    DoctorDelayEvent.findOne({
      where: { doctor_id: doctorId, event_date: date, status: DelayStatus.ACTIVE },
      order: [['created_at', 'DESC']],
    }),
  ]);

  if (!doctor || !hospital) return fail('NOT_FOUND', 'Doctor or hospital not found.', 404);

  const inConsult  = entries.find((e) => e.status === QueueStatus.IN_CONSULTATION);
  const called     = entries.find((e) => e.status === QueueStatus.CALLED);
  const current    = inConsult ?? called;
  const waiting    = entries.filter((e) => e.status === QueueStatus.WAITING);
  const nextTokens = waiting.slice(0, 5).map((e) => e.queue_position);

  const result: QueueDisplayResult = {
    doctor:        { full_name: (doctor as any).full_name, specialization: (doctor as any).specialization },
    hospital:      { name: (hospital as any).name, city: (hospital as any).city },
    current_token: current?.queue_position ?? null,
    status:        inConsult ? 'in_consultation' : called ? 'called' : delayEvent ? 'delayed' : 'available',
    next_tokens:   nextTokens,
    total_waiting: waiting.length,
    delay_minutes: delayEvent?.delay_minutes ?? 0,
    last_updated:  new Date().toISOString(),
  };

  await redis.setex(cacheKey, 10, JSON.stringify(result));
  return ok(result);
}

// ── Hospital-wide display (all active doctors today) ─────────────────────────

export interface HospitalDisplayResult {
  hospital:  { name: string; city: string };
  doctors:   QueueDisplayResult[];
  generated: string;
}

export async function getHospitalQueueDisplay(
  hospitalId: string,
): Promise<ServiceResponse<HospitalDisplayResult>> {
  const cacheKey = `queue:hospital-display:${hospitalId}`;
  const cached = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached) as HospitalDisplayResult);

  const date = new Date().toISOString().split('T')[0];

  const hospital = await Hospital.findByPk(hospitalId, { attributes: ['name', 'city'] });
  if (!hospital) return fail('NOT_FOUND', 'Hospital not found.', 404);

  // Find all doctors who have queue entries today for this hospital
  const activeEntries = await ConsultationQueue.findAll({
    where:      { hospital_id: hospitalId, queue_date: date },
    attributes: ['doctor_id'],
    group:      ['doctor_id'],
  });

  const doctorIds = activeEntries.map((e) => e.doctor_id);

  const doctorResults = await Promise.all(
    doctorIds.map(async (doctorId) => {
      const res = await getQueueDisplay(doctorId, hospitalId);
      return res.success ? res.data : null;
    }),
  );

  const result: HospitalDisplayResult = {
    hospital:  { name: (hospital as any).name, city: (hospital as any).city },
    doctors:   doctorResults.filter(Boolean) as QueueDisplayResult[],
    generated: new Date().toISOString(),
  };

  await redis.setex(cacheKey, 10, JSON.stringify(result));
  return ok(result);
}

export async function addToQueue(
  appointmentId: string,
  doctorId:      string,
  hospitalId:    string,
  patientId:     string,
  scheduledAt:   Date,
): Promise<ServiceResponse<{ queue_position: number }>> {
  const date = scheduledAt.toISOString().split('T')[0];
  const last = await ConsultationQueue.findOne({
    where: { doctor_id: doctorId, queue_date: date },
    order: [['queue_position', 'DESC']],
  });
  const position = (last?.queue_position ?? 0) + 1;

  await ConsultationQueue.create({
    doctor_id: doctorId, hospital_id: hospitalId,
    appointment_id: appointmentId, patient_id: patientId,
    queue_date: date, queue_position: position,
    status: QueueStatus.WAITING,
    estimated_start_at: scheduledAt,
    actual_start_at: null, actual_end_at: null,
    arrived_at: null, called_at: null, notified_at: null,
  });

  logger.info('Patient added to queue', { appointmentId, position });
  return ok({ queue_position: position });
}

export async function invalidateQueueCache(doctorId: string, date: string): Promise<void> {
  await redis.del(RedisKeys.availableSlots(doctorId, date));
  const keys = await redis.keys('queue:status:*');
  if (keys.length) await redis.del(...keys);
}
