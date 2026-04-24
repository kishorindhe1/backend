import { Op, fn, col, literal } from 'sequelize';
import { sequelize }                  from '../../config/database';
import {
  ConsultationQueue, QueueStatus,
  Appointment, AppointmentStatus, PaymentStatus, CancellationBy, PaymentMode, AppointmentType,
  PriorityTier,
  DoctorDelayEvent, DelayStatus, DelayType,
  DoctorHospitalAffiliation,
  DoctorProfile,
  PatientProfile, Gender,
  GeneratedSlot, SlotStatus,
  OpdSlotSession, OpdSlotStatus,
  OpdSession, OpdSessionStatus,
  OpdToken, OpdTokenType, OpdTokenStatus,
  WalkInToken, WalkInTokenStatus,
  HospitalPatient,
  HospitalCollection, CollectionMode,
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

// Priority tier ordering — lower = higher priority
const PRIORITY_ORDER: Record<string, number> = {
  [PriorityTier.EMERGENCY]:         1,
  [PriorityTier.SENIOR]:            2,
  [PriorityTier.DIFFERENTLY_ABLED]: 3,
  [PriorityTier.PREGNANT]:          4,
  [PriorityTier.FOLLOW_UP]:         5,
  [PriorityTier.REGULAR]:           6,
};

// ── Call next patient (priority-aware) ───────────────────────────────────────
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
    await updateAvgConsultationTime(doctorId, inProgress);
  }

  // Fetch all arrived+waiting patients, then sort by priority tier then position
  const waiting = await ConsultationQueue.findAll({
    where: {
      doctor_id:  doctorId,
      queue_date: date,
      status:     QueueStatus.WAITING,
      arrived_at: { [Op.ne]: null },  // must have arrived
    },
    include: [{ model: Appointment, as: 'appointment', attributes: ['priority_tier'] }],
    order: [['queue_position', 'ASC']],
  });

  if (!waiting.length) {
    // No arrived patients — check if there are any waiting (not yet arrived)
    const any = await ConsultationQueue.count({ where: { doctor_id: doctorId, queue_date: date, status: QueueStatus.WAITING } });
    return ok({ message: any > 0 ? 'No patients have arrived yet.' : 'No more patients in queue.', queue_empty: any === 0 });
  }

  // Sort: priority tier first, then queue position
  waiting.sort((a, b) => {
    const appt_a = (a as any).appointment;
    const appt_b = (b as any).appointment;
    const pa = PRIORITY_ORDER[appt_a?.priority_tier ?? PriorityTier.REGULAR] ?? 6;
    const pb = PRIORITY_ORDER[appt_b?.priority_tier ?? PriorityTier.REGULAR] ?? 6;
    if (pa !== pb) return pa - pb;
    return a.queue_position - b.queue_position;
  });

  const next = waiting[0];
  await next.update({ status: QueueStatus.CALLED, called_at: new Date() });
  await invalidateQueueCache(doctorId, date);

  const appt = (next as any).appointment;
  const priorityLabel = appt?.priority_tier && appt.priority_tier !== PriorityTier.REGULAR
    ? ` [${appt.priority_tier.replace('_', ' ')}]`
    : '';

  logger.info('Next patient called', { doctorId, token: next.queue_position, priority: appt?.priority_tier });
  return ok({
    message:       `Token ${next.queue_position} called.${priorityLabel}`,
    queue_position: next.queue_position,
    appointment_id: next.appointment_id,
    priority_tier:  appt?.priority_tier ?? PriorityTier.REGULAR,
  });
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

  const delayPayload = { name: 'Patient', doctor: lateDoc?.full_name ?? 'Doctor', delay: delayMinutes, estimatedTime };

  // Notify appointment-based queue patients
  const waitingEntries = await ConsultationQueue.findAll({
    where: { doctor_id: doctorId, queue_date: date, status: QueueStatus.WAITING },
    attributes: ['patient_id', 'appointment_id'],
  });
  for (const entry of waitingEntries) {
    await enqueueNotification({
      userId: entry.patient_id, appointmentId: entry.appointment_id,
      type: 'doctor_late', channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
      data: delayPayload,
    });
  }

  // Also notify OPD token session holders who haven't been seen yet
  const activeSession = await OpdSession.findOne({
    where: {
      doctor_id: doctorId, hospital_id: hospitalId, session_date: date,
      status: { [Op.in]: [OpdSessionStatus.SCHEDULED, OpdSessionStatus.ACTIVE] },
    },
  });
  if (activeSession) {
    const tokenHolders = await OpdToken.findAll({
      where: {
        session_id: activeSession.id,
        patient_id: { [Op.ne]: null },
        status: { [Op.in]: [OpdTokenStatus.ISSUED, OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING] },
      },
      attributes: ['patient_id'],
    });
    for (const token of tokenHolders) {
      await enqueueNotification({
        userId: token.patient_id!, type: 'doctor_late',
        channels: [NotificationChannel.SMS, NotificationChannel.PUSH], priority: 'high',
        data: delayPayload,
      });
    }
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

// ── Issue governance walk-in token (linked to OpdSlotSession) ─────────────────
export interface WalkInTokenInput {
  doctor_id:    string;
  hospital_id:  string;
  patient_id?:  string;    // registered patient user_id (optional)
  patient_name?: string;   // name for unregistered walk-ins
  created_by:   string;    // receptionist user_id
}

export async function issueWalkInToken(input: WalkInTokenInput): Promise<ServiceResponse<{
  token_id: string;
  token_number: number;
  slot_id: string | null;
  slot_start_time: string | null;
  message: string;
}>> {
  const { doctor_id, hospital_id, patient_id, patient_name, created_by } = input;
  const date = new Date().toISOString().split('T')[0];

  // Next token number for today
  const last = await WalkInToken.findOne({
    where: { doctor_id, hospital_id, date },
    order: [['token_number', 'DESC']],
  });
  const tokenNumber = (last?.token_number ?? 0) + 1;

  // Find an empty published slot (not booked, not blocked)
  const emptySlot = await OpdSlotSession.findOne({
    where: { doctor_id, hospital_id, date, status: OpdSlotStatus.PUBLISHED },
    order: [['slot_start_time', 'ASC']],
  });

  // Create walk-in token
  const token = await WalkInToken.create({
    doctor_id,
    hospital_id,
    date,
    token_number: tokenNumber,
    patient_id:   patient_id  ?? null,
    patient_name: patient_name ?? null,
    status:       WalkInTokenStatus.WAITING,
    slot_id:      emptySlot?.id ?? null,
    created_by,
  });

  // Assign the slot to this walk-in
  if (emptySlot) {
    await emptySlot.update({
      status:           OpdSlotStatus.BOOKED,
      walk_in_token_id: token.id,
    });
  }

  logger.info('Walk-in token issued', { tokenNumber, doctorId: doctor_id, hospitalId: hospital_id, slotId: emptySlot?.id });
  return ok({
    token_id:        token.id,
    token_number:    tokenNumber,
    slot_id:         emptySlot?.id ?? null,
    slot_start_time: emptySlot?.slot_start_time ?? null,
    message:         emptySlot
      ? `Walk-in token #${tokenNumber} issued. Slot: ${emptySlot.slot_start_time}`
      : `Walk-in token #${tokenNumber} issued. No empty slot available — patient added to end of queue.`,
  });
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

// ── Patient Lookup ────────────────────────────────────────────────────────────
export async function patientLookup(
  query:      string,
  hospitalId: string,
): Promise<ServiceResponse<object>> {
  const isMobile = /^\d{7,15}$/.test(query.trim());

  // Find matching users
  let users: User[];
  if (isMobile) {
    users = await User.findAll({
      where: { mobile: query.trim() },
      include: [{ model: PatientProfile, as: 'patientProfile' }],
    });
  } else {
    users = await User.findAll({
      include: [{
        model: PatientProfile,
        as: 'patientProfile',
        where: { full_name: { [Op.iLike]: `%${query.trim()}%` } },
        required: true,
      }],
      limit: 10,
    });
  }

  if (!users.length) return ok({ case: 'not_found', patients: [] });

  const results = await Promise.all(users.map(async (user) => {
    const profile = (user as any).patientProfile as PatientProfile | null;
    const hospitalPatient = await HospitalPatient.findOne({
      where: { hospital_id: hospitalId, patient_id: user.id },
    });

    return {
      patient_id:   user.id,
      mobile:       user.mobile,
      full_name:    profile?.full_name ?? null,
      gender:       profile?.gender ?? null,
      date_of_birth: profile?.date_of_birth ?? null,
      case:         hospitalPatient ? 'returning' : 'first_visit',
      hospital_record: hospitalPatient ? {
        first_visit_at: hospitalPatient.first_visit_at,
        last_visit_at:  hospitalPatient.last_visit_at,
        total_visits:   hospitalPatient.total_visits,
        notes:          hospitalPatient.notes,
      } : null,
    };
  }));

  return ok({ patients: results });
}

// ── Quick Register ────────────────────────────────────────────────────────────
export interface QuickRegisterInput {
  mobile:     string;
  full_name:  string;
  age?:       number;
  gender?:    Gender;
  hospital_id: string;
  registered_by: string;
}

export async function quickRegister(input: QuickRegisterInput): Promise<ServiceResponse<object>> {
  const { mobile, full_name, age, gender, hospital_id, registered_by } = input;

  const existing = await User.findOne({ where: { mobile } });
  if (existing) return fail('MOBILE_TAKEN', 'A patient with this mobile number already exists. Use patient lookup.', 409);

  const today = new Date().toISOString().split('T')[0];

  const result = await sequelize.transaction(async (t) => {
    const user = await User.create({
      mobile,
      country_code:   '+91',
      role:           UserRole.PATIENT,
      account_status: AccountStatus.ACTIVE,
      email:          null,
      password_hash:  null,
      otp_secret:     null,
      otp_expires_at: null,
      otp_attempts:   0,
      last_login_at:  null,
      deleted_at:     null,
    }, { transaction: t });

    let dob: Date | null = null;
    if (age) {
      dob = new Date();
      dob.setFullYear(dob.getFullYear() - age);
    }

    await PatientProfile.create({
      user_id:       user.id,
      full_name,
      gender:        gender ?? null,
      date_of_birth: dob,
      email:         null,
      blood_group:   null,
      profile_photo_url: null,
      completed_at:  null,
    } as any, { transaction: t });

    await HospitalPatient.create({
      hospital_id,
      patient_id:    user.id,
      first_visit_at: today,
      last_visit_at:  today,
      total_visits:   1,
      notes:          null,
    }, { transaction: t });

    return user;
  });

  logger.info('Patient quick-registered', { userId: result.id, mobile, hospital_id, registered_by });
  return ok({ patient_id: result.id, mobile, full_name, message: 'Patient registered successfully.' });
}

// ── Start Visit (upsert hospital_patients + issue walk-in token) ──────────────
export interface StartVisitInput {
  patient_id:  string;
  hospital_id: string;
  doctor_id:   string;
  created_by:  string;
  patient_name?: string;
}

export async function startVisit(input: StartVisitInput): Promise<ServiceResponse<object>> {
  const { patient_id, hospital_id, doctor_id, created_by, patient_name } = input;

  const today = new Date().toISOString().split('T')[0];

  // Upsert hospital_patients record
  const existing = await HospitalPatient.findOne({ where: { hospital_id, patient_id } });
  if (existing) {
    await existing.update({ last_visit_at: today, total_visits: existing.total_visits + 1 });
  } else {
    await HospitalPatient.create({
      hospital_id,
      patient_id,
      first_visit_at: today,
      last_visit_at:  today,
      total_visits:   1,
      notes:          null,
    });
  }

  // Issue walk-in token
  const tokenResult = await issueWalkInToken({ doctor_id, hospital_id, patient_id, patient_name, created_by });

  logger.info('Visit started', { patient_id, hospital_id, doctor_id });
  return tokenResult;
}

// ── Collect Payment ───────────────────────────────────────────────────────────
export interface CollectPaymentInput {
  hospital_id:     string;
  patient_id?:     string;
  amount:          number;
  mode:            CollectionMode;
  collected_by:    string;
  appointment_id?: string;
  opd_token_id?:   string;
  notes?:          string;
}

export async function collectPayment(input: CollectPaymentInput): Promise<ServiceResponse<object>> {
  const { hospital_id, patient_id, amount, mode, collected_by, appointment_id, opd_token_id, notes } = input;

  const collection = await HospitalCollection.create({
    hospital_id,
    patient_id:     patient_id     ?? null,
    appointment_id: appointment_id ?? null,
    opd_token_id:   opd_token_id   ?? null,
    amount,
    mode,
    collected_by,
    notes:          notes ?? null,
  });

  // Mark linked appointment as paid
  if (appointment_id) {
    await Appointment.update(
      { payment_status: PaymentStatus.CAPTURED, payment_mode: PaymentMode.CASH },
      { where: { id: appointment_id } },
    );
  }

  logger.info('Payment collected', { collectionId: collection.id, amount, mode, hospital_id });
  return ok({
    collection_id: collection.id,
    amount,
    mode,
    collected_at: collection.collected_at,
    message: `Payment of ₹${amount} collected via ${mode}.`,
  });
}

// ── Get Collections (daily summary) ──────────────────────────────────────────
export async function getCollections(
  hospitalId: string,
  date:       string,
  doctorId?:  string,
): Promise<ServiceResponse<object>> {
  const startOfDay = new Date(`${date}T00:00:00.000Z`);
  const endOfDay   = new Date(`${date}T23:59:59.999Z`);

  const whereClause: any = {
    hospital_id:  hospitalId,
    collected_at: { [Op.between]: [startOfDay, endOfDay] },
  };

  const collections = await HospitalCollection.findAll({
    where: whereClause,
    include: [
      { model: User, as: 'patient',      attributes: ['id', 'mobile'] },
      { model: User, as: 'collectedByUser', attributes: ['id', 'mobile'] },
    ],
    order: [['collected_at', 'DESC']],
  });

  // Breakdown by mode
  const breakdown: Record<string, number> = {};
  let total = 0;
  for (const c of collections) {
    breakdown[c.mode] = (breakdown[c.mode] ?? 0) + Number(c.amount);
    total += Number(c.amount);
  }

  return ok({
    date,
    total,
    breakdown,
    count: collections.length,
    collections: collections.map(c => ({
      id:             c.id,
      amount:         Number(c.amount),
      mode:           c.mode,
      collected_at:   c.collected_at,
      patient:        (c as any).patient ?? null,
      appointment_id: c.appointment_id,
      opd_token_id:   c.opd_token_id,
      notes:          c.notes,
    })),
  });
}
