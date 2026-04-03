import { Op } from 'sequelize';
import { sequelize }                  from '../../config/database';
import {
  ConsultationQueue, QueueStatus,
  Appointment, AppointmentStatus, PaymentStatus, CancellationBy, PaymentMode, AppointmentType,
  DoctorDelayEvent, DelayStatus, DelayType,
  DoctorHospitalAffiliation,
  DoctorProfile,
  GeneratedSlot, SlotStatus,
  User,
}                                     from '../../models';
import { NotificationChannel } from '../../models';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { ErrorFactory }               from '../../utils/errors';
import { enqueueNotification } from '../notifications/notification.service';
import { invalidateQueueCache }       from '../queue/queue.service';
import { logger }                     from '../../utils/logger';

// ── Mark patient arrived at clinic ────────────────────────────────────────────
export async function markPatientArrived(
  appointmentId: string,
  hospitalId:    string,
): Promise<ServiceResponse<object>> {
  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) throw ErrorFactory.notFound('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.');

  if (entry.arrived_at) return fail('ALREADY_ARRIVED', 'Patient already marked as arrived.', 409);

  await entry.update({ arrived_at: new Date(), status: QueueStatus.WAITING });
  logger.info('Patient arrived', { appointmentId });
  return ok({ message: 'Patient marked as arrived.', queue_position: entry.queue_position });
}

// ── Call next patient ─────────────────────────────────────────────────────────
export async function callNextPatient(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<object>> {
  const date = new Date().toISOString().split('T')[0];

  // Complete current in-progress if any
  const inProgress = await ConsultationQueue.findOne({
    where: { doctor_id: doctorId, queue_date: date, status: QueueStatus.IN_CONSULTATION },
  });
  if (inProgress) {
    await inProgress.update({ status: QueueStatus.COMPLETED, actual_end_at: new Date() });
    // Update avg consultation time on doctor profile
    await updateAvgConsultationTime(doctorId, inProgress);
  }

  // Find next waiting patient
  const next = await ConsultationQueue.findOne({
    where: { doctor_id: doctorId, queue_date: date, status: { [Op.in]: [QueueStatus.WAITING] } },
    order: [['queue_position', 'ASC']],
    include: [{ model: Appointment, as: 'appointment' }],
  });

  if (!next) return ok({ message: 'No more patients in queue.', queue_empty: true });

  await next.update({ status: QueueStatus.CALLED, called_at: new Date() });
  await invalidateQueueCache(doctorId, date);

  logger.info('Next patient called', { doctorId, token: next.queue_position });
  return ok({ message: `Token ${next.queue_position} called.`, queue_position: next.queue_position, appointment_id: next.appointment_id });
}

// ── Start consultation ────────────────────────────────────────────────────────
export async function startConsultation(
  appointmentId: string,
): Promise<ServiceResponse<object>> {
  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) throw ErrorFactory.notFound('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.');

  if (entry.status === QueueStatus.IN_CONSULTATION) return fail('ALREADY_IN_PROGRESS', 'Consultation already in progress.', 409);

  await entry.update({ status: QueueStatus.IN_CONSULTATION, actual_start_at: new Date() });

  // Update appointment status
  await Appointment.update({ status: AppointmentStatus.IN_PROGRESS }, { where: { id: appointmentId } });

  logger.info('Consultation started', { appointmentId });
  return ok({ message: 'Consultation started.', started_at: new Date() });
}

// ── Skip patient ──────────────────────────────────────────────────────────────
export async function skipPatient(
  appointmentId: string,
  reason?:       string,
): Promise<ServiceResponse<object>> {
  const entry = await ConsultationQueue.findOne({ where: { appointment_id: appointmentId } });
  if (!entry) throw ErrorFactory.notFound('QUEUE_ENTRY_NOT_FOUND', 'Queue entry not found.');

  await entry.update({ status: QueueStatus.SKIPPED });
  const date = entry.queue_date;
  await invalidateQueueCache(entry.doctor_id, date);

  logger.info('Patient skipped', { appointmentId, reason });
  return ok({ message: 'Patient marked as skipped.' });
}

// ── Mark doctor arrived (check-in) ────────────────────────────────────────────
export async function doctorCheckIn(
  doctorId:        string,
  hospitalId:      string,
  reportedByUserId:string,
): Promise<ServiceResponse<object>> {
  const date = new Date().toISOString().split('T')[0];

  // Resolve any active delay event
  await DoctorDelayEvent.update(
    { status: DelayStatus.RESOLVED, actual_arrival: new Date() },
    { where: { doctor_id: doctorId, event_date: date, status: DelayStatus.ACTIVE } },
  );

  await invalidateQueueCache(doctorId, date);
  logger.info('Doctor checked in', { doctorId, reportedBy: reportedByUserId });
  return ok({ message: 'Doctor checked in successfully.', checked_in_at: new Date() });
}

// ── Report doctor delay ───────────────────────────────────────────────────────
export async function reportDoctorDelay(
  doctorId:        string,
  hospitalId:      string,
  delayMinutes:    number,
  reason:          string | undefined,
  reportedByUserId:string,
): Promise<ServiceResponse<object>> {
  const date = new Date().toISOString().split('T')[0];

  // Close any existing delay event
  await DoctorDelayEvent.update(
    { status: DelayStatus.RESOLVED },
    { where: { doctor_id: doctorId, event_date: date, status: DelayStatus.ACTIVE } },
  );

  // Count affected appointments today
  const affectedCount = await ConsultationQueue.count({
    where: { doctor_id: doctorId, queue_date: date, status: QueueStatus.WAITING },
  });

  const event = await DoctorDelayEvent.create({
    doctor_id:        doctorId,
    hospital_id:      hospitalId,
    event_date:       date,
    delay_type:       DelayType.LATE_ARRIVAL,
    delay_minutes:    delayMinutes,
    reason:           reason ?? null,
    reported_by:      reportedByUserId,
    expected_arrival: new Date(Date.now() + delayMinutes * 60_000),
    actual_arrival:   null,
    status:           DelayStatus.ACTIVE,
    affected_slots:   affectedCount,
    patients_notified:false,
  });

  await invalidateQueueCache(doctorId, date);

  const lateDoc = await DoctorProfile.findByPk(doctorId, { attributes: ['full_name'] });
  const estimatedTime = new Date(Date.now() + delayMinutes * 60_000)
    .toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });

  // Notify all waiting patients about the delay
  const waitingEntries = await ConsultationQueue.findAll({
    where: { doctor_id: doctorId, queue_date: date, status: QueueStatus.WAITING },
    attributes: ['patient_id', 'appointment_id'],
  });
  for (const entry of waitingEntries) {
    await enqueueNotification({
      userId: entry.patient_id, appointmentId: entry.appointment_id,
      type: 'doctor_late', channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: { name: 'Patient', doctor: lateDoc?.full_name ?? 'Doctor', delay: delayMinutes, estimatedTime },
    });
  }
  await event.update({ patients_notified: true });

  logger.info('Doctor delay reported', { doctorId, delayMinutes, affectedCount });

  return ok({
    event_id:        event.id,
    delay_minutes:   delayMinutes,
    affected_patients: affectedCount,
    message:         `Delay reported. ${affectedCount} patients will be notified.`,
  });
}

// ── Mark doctor absent (full day cancellation) ────────────────────────────────
export async function markDoctorAbsent(
  doctorId:        string,
  hospitalId:      string,
  reason:          string | undefined,
  reportedByUserId:string,
): Promise<ServiceResponse<object>> {
  const date = new Date().toISOString().split('T')[0];

  await DoctorDelayEvent.create({
    doctor_id:        doctorId,
    hospital_id:      hospitalId,
    event_date:       date,
    delay_type:       DelayType.ABSENT,
    delay_minutes:    null,
    reason:           reason ?? null,
    reported_by:      reportedByUserId,
    expected_arrival: null,
    actual_arrival:   null,
    status:           DelayStatus.CANCELLED_DAY,
    affected_slots:   0,
    patients_notified:false,
  });

  // Cancel all today's pending/confirmed appointments
  const cancelledCount = await cancelDoctorDayAppointments(doctorId, hospitalId, date);
  await invalidateQueueCache(doctorId, date);

  const absentDoc = await DoctorProfile.findByPk(doctorId, { attributes: ['full_name'] });

  // Notify each cancelled patient
  const cancelledAppts = await Appointment.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, status: AppointmentStatus.CANCELLED, cancelled_at: { [Op.gte]: new Date(Date.now() - 60_000) } },
    attributes: ['patient_id', 'id'],
  });
  for (const appt of cancelledAppts) {
    await enqueueNotification({
      userId: appt.patient_id, appointmentId: appt.id,
      type: 'doctor_absent', channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'critical',
      data: { name: 'Patient', doctor: absentDoc?.full_name ?? 'Doctor', date },
    });
  }

  logger.info('Doctor marked absent', { doctorId, date, cancelledCount });
  return ok({ message: `Doctor marked absent. ${cancelledCount} appointments cancelled and refunds initiated.`, cancelled_count: cancelledCount });
}

// ── Book walk-in patient ──────────────────────────────────────────────────────
export interface WalkInInput {
  doctor_id:   string;
  hospital_id: string;
  patient_mobile: string;
  receptionist_id: string;
}

export async function bookWalkIn(input: WalkInInput): Promise<ServiceResponse<object>> {
  const { doctor_id, hospital_id, patient_mobile, receptionist_id } = input;

  // Find or create patient
  const [user] = await User.findOrCreate({
    where:  { mobile: patient_mobile },
    defaults: { mobile: patient_mobile, country_code: '+91', role: UserRole.PATIENT, account_status: AccountStatus.ACTIVE, otp_secret: null, otp_expires_at: null, otp_attempts: 0, last_login_at: null, deleted_at: null },
  });

  const affiliation = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id, hospital_id, is_active: true },
  });
  if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.');

  const fee = Number(affiliation.consultation_fee);
  const platformFee  = Math.round(fee * 0.02 * 100) / 100;
  const doctorPayout = fee - platformFee;

  // Create a walk-in appointment (no slot required)
  const appointment = await Appointment.create({
    patient_id:       user.id,
    doctor_id,
    hospital_id,
    slot_id:          null, // walk-ins don't occupy a generated slot
    scheduled_at:     new Date(),
    status:           AppointmentStatus.CONFIRMED,
    payment_status:   PaymentStatus.PENDING,
    appointment_type: AppointmentType.WALK_IN,
    payment_mode:     PaymentMode.CASH,
    consultation_fee: fee,
    platform_fee:     platformFee,
    doctor_payout:    doctorPayout,
    notes:            null,
    cancellation_reason: null,
    cancelled_by:     null,
    cancelled_at:     null,
    razorpay_order_id: null,
  });

  // Add to queue
  const date = new Date().toISOString().split('T')[0];
  const last = await ConsultationQueue.findOne({
    where: { doctor_id, queue_date: date }, order: [['queue_position', 'DESC']],
  });
  const position = (last?.queue_position ?? 0) + 1;

  await ConsultationQueue.create({
    doctor_id, hospital_id,
    appointment_id: appointment.id,
    patient_id:     user.id,
    queue_date:     date,
    queue_position: position,
    status:         QueueStatus.WAITING,
    estimated_start_at: new Date(),
    actual_start_at: null, actual_end_at: null,
    arrived_at:     new Date(),
    called_at: null, notified_at: null,
  });

  logger.info('Walk-in booked', { appointmentId: appointment.id, mobile: patient_mobile, position });
  return ok({ appointment_id: appointment.id, queue_position: position, patient_id: user.id, fee, message: `Walk-in registered. Token #${position}` });
}

// ── Internal helpers ──────────────────────────────────────────────────────────
async function cancelDoctorDayAppointments(doctorId: string, hospitalId: string, date: string): Promise<number> {
  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay   = new Date(`${date}T23:59:59.999Z`);

  const appointments = await Appointment.findAll({
    where: {
      doctor_id: doctorId, hospital_id: hospitalId,
      scheduled_at: { [Op.between]: [startOfDay, endOfDay] },
      status: { [Op.in]: [AppointmentStatus.PENDING, AppointmentStatus.CONFIRMED] },
    },
  });

  for (const appt of appointments) {
    await appt.update({
      status:              AppointmentStatus.CANCELLED,
      payment_status:      appt.payment_status === PaymentStatus.CAPTURED ? PaymentStatus.REFUND_PENDING : appt.payment_status,
      cancellation_reason: 'Doctor unavailable today',
      cancelled_by:        CancellationBy.SYSTEM,
      cancelled_at:        new Date(),
    });
    // Free slot
    if (appt.slot_id) {
      await GeneratedSlot.update({ status: SlotStatus.AVAILABLE, appointment_id: null }, { where: { id: appt.slot_id } });
    }
  }

  return appointments.length;
}

async function updateAvgConsultationTime(doctorId: string, completedEntry: ConsultationQueue): Promise<void> {
  if (!completedEntry.actual_start_at || !completedEntry.actual_end_at) return;
  const durationMin = (completedEntry.actual_end_at.getTime() - completedEntry.actual_start_at.getTime()) / 60_000;
  // Simple exponential moving average — update doctor profile
  const { DoctorProfile } = await import('../../models');
  const doc = await DoctorProfile.findByPk(doctorId);
  if (!doc) return;
  const current = Number(doc.avg_consultation_minutes);
  const updated = Math.round((current * 0.9 + durationMin * 0.1) * 100) / 100;
  await doc.update({ avg_consultation_minutes: updated });
}
