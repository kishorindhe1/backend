import { Op } from 'sequelize';
import {
  Appointment,
  AppointmentStatus,
  ConsultationQueue,
  DoctorAvailabilityOverride,
  DoctorHospitalAffiliation,
  DoctorProfile,
  Hospital,
  OpdSession,
  QueueStatus,
  Schedule,
  User,
  PatientProfile,
  OverrideType,
} from '../../models';
import { ServiceResponse, fail, ok } from '../../types';
import { istDate } from '../../utils/dateTime';
import { invalidateQueueCache } from '../queue/queue.service';
import { markConsultationDone } from '../doctor-app/doctor-app.service';
import { resolveDoctorIdentity } from '../doctor-auth/doctor-auth.service';

type AvailabilityChangeType = 'day_off' | 'late_start' | 'early_end' | 'break' | 'running_late';

const CHANGE_TO_OVERRIDE: Record<AvailabilityChangeType, OverrideType> = {
  day_off: OverrideType.DAY_OFF,
  late_start: OverrideType.LATE_START,
  early_end: OverrideType.EARLY_END,
  break: OverrideType.BREAK,
  running_late: OverrideType.RUNNING_LATE,
};

function statusCounts(queue: ConsultationQueue[]) {
  return {
    waiting: queue.filter((q) => q.status === QueueStatus.WAITING).length,
    called: queue.filter((q) => q.status === QueueStatus.CALLED).length,
    in_consultation: queue.filter((q) => q.status === QueueStatus.IN_CONSULTATION).length,
    completed: queue.filter((q) => q.status === QueueStatus.COMPLETED).length,
    skipped: queue.filter((q) => q.status === QueueStatus.SKIPPED).length,
    no_show: queue.filter((q) => q.status === QueueStatus.NO_SHOW).length,
    total: queue.length,
  };
}

async function defaultHospitalForDoctor(doctorId: string): Promise<DoctorHospitalAffiliation | null> {
  return DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, is_primary: true, is_active: true },
  }) ?? DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, is_active: true },
    order: [['created_at', 'ASC']],
  });
}

export async function getToday(userId: string, date = istDate()): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;

  const { doctor } = identity.data;
  const affiliation = identity.data.hospitalId
    ? await DoctorHospitalAffiliation.findOne({ where: { doctor_id: doctor.id, hospital_id: identity.data.hospitalId, is_active: true } })
    : await defaultHospitalForDoctor(doctor.id);

  const queue = affiliation
    ? await ConsultationQueue.findAll({
      where: { doctor_id: doctor.id, hospital_id: affiliation.hospital_id, queue_date: date },
      order: [['queue_position', 'ASC']],
      include: [{
        model: Appointment,
        as: 'appointment',
        attributes: ['id', 'scheduled_at', 'appointment_type', 'notes'],
        include: [{
          model: User,
          as: 'patient',
          attributes: ['id', 'mobile'],
          include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'], required: false }],
        }],
      }],
    })
    : [];

  const hospital = affiliation
    ? await Hospital.findByPk(affiliation.hospital_id, { attributes: ['id', 'name'] })
    : null;

  return ok({
    date,
    doctor: {
      id: doctor.id,
      full_name: doctor.full_name,
      specialization: doctor.specialization,
    },
    hospital: hospital ? { id: hospital.id, name: hospital.name } : null,
    stats: statusCounts(queue),
    queue: queue.map((entry) => {
      const appointment = entry.get('appointment') as (Appointment & { patient?: User & { patientProfile?: PatientProfile } }) | null;
      const patient = appointment?.patient;
      return {
        id: entry.id,
        appointment_id: entry.appointment_id,
        queue_position: entry.queue_position,
        status: entry.status,
        appointment_type: appointment?.appointment_type ?? 'online_booking',
        patient_name: patient?.patientProfile?.full_name ?? null,
        patient_mobile: patient?.mobile ?? null,
        notes: appointment?.notes ?? null,
        scheduled_at: appointment?.scheduled_at?.toISOString() ?? null,
        arrived_at: entry.arrived_at?.toISOString() ?? null,
        called_at: entry.called_at?.toISOString() ?? null,
        consultation_start: entry.actual_start_at?.toISOString() ?? null,
        consultation_end: entry.actual_end_at?.toISOString() ?? null,
      };
    }),
  });
}

export async function startConsultation(userId: string, appointmentId: string): Promise<ServiceResponse<{ message: string }>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;

  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) return fail('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.', 404);
  if (entry.doctor_id !== identity.data.doctor.id) return fail('FORBIDDEN', 'Not your patient.', 403);
  if (![QueueStatus.WAITING, QueueStatus.CALLED].includes(entry.status)) {
    return fail('INVALID_QUEUE_STATUS', 'Patient cannot be started from current status.', 409);
  }

  await entry.update({
    status: QueueStatus.IN_CONSULTATION,
    actual_start_at: new Date(),
    called_at: entry.called_at ?? new Date(),
  });
  await Appointment.update({ status: AppointmentStatus.IN_PROGRESS }, { where: { id: appointmentId } });
  await invalidateQueueCache(entry.doctor_id, entry.queue_date);
  return ok({ message: 'Consultation started.' });
}

export async function completeConsultation(userId: string, appointmentId: string): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;
  return markConsultationDone(appointmentId, identity.data.doctor.id);
}

export async function skipAppointment(userId: string, appointmentId: string): Promise<ServiceResponse<{ message: string }>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;

  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) return fail('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.', 404);
  if (entry.doctor_id !== identity.data.doctor.id) return fail('FORBIDDEN', 'Not your patient.', 403);
  if (![QueueStatus.WAITING, QueueStatus.CALLED].includes(entry.status)) {
    return fail('INVALID_QUEUE_STATUS', 'Patient cannot be skipped from current status.', 409);
  }

  await entry.update({ status: QueueStatus.SKIPPED });
  await Appointment.update({ status: AppointmentStatus.MISSED }, { where: { id: appointmentId } });
  await invalidateQueueCache(entry.doctor_id, entry.queue_date);
  return ok({ message: 'Patient skipped.' });
}

export async function reportDelay(
  userId: string,
  input: { delay_minutes: number; reason?: string },
): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;
  const hospitalId = identity.data.hospitalId ?? (await defaultHospitalForDoctor(identity.data.doctor.id))?.hospital_id;
  if (!hospitalId) return fail('NO_HOSPITAL', 'Doctor is not linked to a hospital.', 400);

  const { selfReportDelay } = await import('../doctor-app/doctor-app.service');
  return selfReportDelay(identity.data.doctor.id, hospitalId, input.delay_minutes, input.reason);
}

export async function getHistory(
  userId: string,
  params: { from?: string; to?: string },
): Promise<ServiceResponse<object[]>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;

  const where: Record<string, unknown> = { doctor_id: identity.data.doctor.id };
  if (params.from || params.to) {
    where.session_date = {
      ...(params.from ? { [Op.gte]: params.from } : {}),
      ...(params.to ? { [Op.lte]: params.to } : {}),
    };
  }

  const sessions = await OpdSession.findAll({
    where,
    order: [['session_date', 'DESC'], ['start_time', 'ASC']],
    include: [{ model: Hospital, as: 'hospital', attributes: ['name'], required: false }],
    limit: 120,
  });

  const rows = [];
  for (const session of sessions) {
    const queue = await ConsultationQueue.findAll({
      where: {
        doctor_id: identity.data.doctor.id,
        hospital_id: session.hospital_id,
        queue_date: session.session_date,
      },
    });
    const counts = statusCounts(queue);
    const hospital = session.get('hospital') as Hospital | null;
    rows.push({
      id: session.id,
      session_date: session.session_date,
      hospital_name: hospital?.name ?? null,
      session_type: session.session_type,
      tokens_issued: session.tokens_issued,
      completed_count: counts.completed,
      skipped_count: counts.skipped,
      no_show_count: counts.no_show,
      avg_consultation_minutes: Number(session.avg_time_per_patient) || null,
    });
  }

  return ok(rows);
}

export async function getAvailability(userId: string): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;
  const hospitalId = identity.data.hospitalId ?? (await defaultHospitalForDoctor(identity.data.doctor.id))?.hospital_id ?? null;

  const schedules = hospitalId
    ? await Schedule.findAll({
      where: { doctor_id: identity.data.doctor.id, hospital_id: hospitalId, is_active: true },
      order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
    })
    : [];

  const overrides = hospitalId
    ? await DoctorAvailabilityOverride.findAll({
      where: { doctor_id: identity.data.doctor.id, hospital_id: hospitalId },
      order: [['date', 'DESC'], ['created_at', 'DESC']],
      limit: 30,
    })
    : [];

  return ok({
    doctor_id: identity.data.doctor.id,
    hospital_id: hospitalId,
    timezone: 'Asia/Kolkata',
    weekly_schedule: schedules.map((s) => ({
      day_of_week: s.day_of_week,
      start_time: s.start_time,
      end_time: s.end_time,
      is_active: s.is_active,
    })),
    pending_requests: overrides.map((o) => ({
      id: o.id,
      date: o.date,
      change_type: o.override_type,
      start_time: o.start_time,
      end_time: o.end_time,
      delay_minutes: o.delay_minutes,
      reason: o.reason,
      status: 'pending',
      created_at: o.created_at.toISOString(),
    })),
  });
}

export async function requestAvailabilityChange(
  userId: string,
  payload: {
    date: string;
    change_type: AvailabilityChangeType;
    start_time?: string;
    end_time?: string;
    delay_minutes?: number;
    reason?: string;
  },
): Promise<ServiceResponse<{ message: string; request_id: string }>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;
  const hospitalId = identity.data.hospitalId ?? (await defaultHospitalForDoctor(identity.data.doctor.id))?.hospital_id;
  if (!hospitalId) return fail('NO_HOSPITAL', 'Doctor is not linked to a hospital.', 400);

  const override = await DoctorAvailabilityOverride.create({
    doctor_id: identity.data.doctor.id,
    hospital_id: hospitalId,
    date: payload.date,
    override_type: CHANGE_TO_OVERRIDE[payload.change_type],
    start_time: payload.start_time ?? null,
    end_time: payload.end_time ?? null,
    delay_minutes: payload.delay_minutes ?? null,
    reason: payload.reason ?? null,
    created_by: identity.data.user.id,
  });

  return ok({ message: 'Availability request sent.', request_id: override.id });
}

export async function getProfile(userId: string): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;
  const affiliation = identity.data.hospitalId
    ? await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: identity.data.doctor.id, hospital_id: identity.data.hospitalId, is_active: true },
      include: [{ model: Hospital, as: 'hospital', attributes: ['id', 'name', 'city'] }],
    })
    : await defaultHospitalForDoctor(identity.data.doctor.id);
  const hospital = affiliation?.get('hospital') as Hospital | undefined;

  return ok({
    id: identity.data.doctor.id,
    full_name: identity.data.doctor.full_name,
    specialization: identity.data.doctor.specialization,
    qualifications: identity.data.doctor.qualifications,
    experience_years: identity.data.doctor.experience_years,
    profile_photo_url: identity.data.doctor.profile_photo_url,
    languages: identity.data.doctor.languages_spoken,
    bio: identity.data.doctor.bio,
    consultation_fee: affiliation?.consultation_fee ? Number(affiliation.consultation_fee) : null,
    hospital: hospital ? { id: hospital.id, name: hospital.name, city: hospital.city } : null,
    verification_status: identity.data.doctor.verification_status,
    account_status: identity.data.user.account_status,
  });
}

export async function updateProfile(
  userId: string,
  payload: { bio?: string; languages?: string[] },
): Promise<ServiceResponse<object>> {
  const identity = await resolveDoctorIdentity(userId);
  if (!identity.success) return identity;

  await identity.data.doctor.update({
    ...(payload.bio !== undefined ? { bio: payload.bio || null } : {}),
    ...(payload.languages !== undefined ? { languages_spoken: payload.languages } : {}),
  });

  return getProfile(userId);
}
