import { Op, QueryTypes }               from 'sequelize';
import { sequelize }                    from '../../config/database';
import { redis }                        from '../../config/redis';
import {
  User,
  PatientProfile,
  DoctorProfile, VerificationStatus,
  Hospital, OnboardingStatus,
  HospitalStaff,
  DoctorHospitalAffiliation,
  Appointment, AppointmentStatus, PaymentStatus,
  Payment, PaymentGatewayStatus,
  ConsultationQueue, QueueStatus,
  DoctorDelayEvent, DelayStatus,
  NotificationLog, NotificationStatus,
  AdminAuditLog, AdminAction,
}                                       from '../../models';
import { UserRole, AccountStatus } from '../../types';
import { ErrorFactory }                 from '../../utils/errors';
import { ServiceResponse, ok, fail }    from '../../types';
import { logger }                       from '../../utils/logger';
import { enqueueNotification }          from '../notifications/notification.service';
import { NotificationChannel }          from '../../models';

// ── Platform health snapshot (reads from Redis live counters) ─────────────────
export async function getPlatformHealth(): Promise<ServiceResponse<object>> {
  const [
    bookingsToday, cancellationsToday,
    registrationsToday, smsDelivered, smsSent,
    paymentsSuccess, paymentsFailed,
  ] = await Promise.all([
    redis.get('stats:today:bookings'),
    redis.get('stats:today:cancellations'),
    redis.get('stats:today:registrations'),
    redis.get('stats:today:sms:delivered'),
    redis.get('stats:today:sms:sent'),
    redis.get('stats:today:payments:success'),
    redis.get('stats:today:payments:failed'),
  ]);

  const today = new Date().toISOString().split('T')[0];

  // Live counts from DB (small queries — not aggregates)
  const [activeDoctors, totalHospitals, patientsInQueue] = await Promise.all([
    DoctorProfile.count({ where: { is_active: true, verification_status: VerificationStatus.APPROVED } }),
    Hospital.count({ where: { onboarding_status: OnboardingStatus.LIVE } }),
    ConsultationQueue.count({ where: { queue_date: today, status: { [Op.in]: [QueueStatus.WAITING, QueueStatus.CALLED, QueueStatus.IN_CONSULTATION] } } }),
  ]);

  const smsSentN     = parseInt(smsSent ?? '0', 10);
  const smsDelivN    = parseInt(smsDelivered ?? '0', 10);
  const smsDelivRate = smsSentN > 0 ? Math.round((smsDelivN / smsSentN) * 1000) / 10 : 100;

  const paySuccN  = parseInt(paymentsSuccess ?? '0', 10);
  const payFailN  = parseInt(paymentsFailed ?? '0', 10);
  const payTotal  = paySuccN + payFailN;
  const payRate   = payTotal > 0 ? Math.round((paySuccN / payTotal) * 1000) / 10 : 100;

  return ok({
    today_snapshot: {
      bookings:      parseInt(bookingsToday ?? '0', 10),
      cancellations: parseInt(cancellationsToday ?? '0', 10),
      registrations: parseInt(registrationsToday ?? '0', 10),
    },
    live: {
      patients_in_queue: patientsInQueue,
      active_doctors:    activeDoctors,
      live_hospitals:    totalHospitals,
    },
    system_health: {
      sms_delivery_rate_pct:     smsDelivRate,
      payment_success_rate_pct:  payRate,
    },
    generated_at: new Date(),
  });
}

// ── Operations alerts ─────────────────────────────────────────────────────────
export async function getOperationsAlerts(): Promise<ServiceResponse<object[]>> {
  const today      = new Date().toISOString().split('T')[0];
  const now        = new Date();
  const alerts: object[] = [];

  // 1. Doctors with active delay today
  const delayEvents = await DoctorDelayEvent.findAll({
    where: { event_date: today, status: DelayStatus.ACTIVE },
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name'] }],
  });
  delayEvents.forEach(e => {
    const doc = (e as unknown as { doctor: DoctorProfile }).doctor;
    alerts.push({
      priority: (e.delay_minutes ?? 0) > 30 ? 'critical' : 'warning',
      type:     'doctor_delay',
      message:  `Dr. ${doc?.full_name} is ${e.delay_minutes} min late. ${e.affected_slots} patients affected.`,
      doctor_id:    e.doctor_id,
      hospital_id:  e.hospital_id,
      delay_minutes:e.delay_minutes,
      affected_patients: e.affected_slots,
    });
  });

  // 2. Patients waiting > 60 minutes
  const longWaits = await ConsultationQueue.findAll({
    where: {
      queue_date: today,
      status: QueueStatus.WAITING,
      arrived_at: { [Op.lt]: new Date(now.getTime() - 60 * 60_000) },
    },
    limit: 10,
  });
  if (longWaits.length > 0) {
    alerts.push({
      priority: 'critical',
      type:     'long_wait',
      message:  `${longWaits.length} patient(s) waiting over 60 minutes.`,
      count:    longWaits.length,
    });
  }

  // 3. Failed notifications (attempt_count >= 5)
  const failedNotifs = await NotificationLog.count({
    where: { status: NotificationStatus.FAILED, attempt_count: { [Op.gte]: 5 } },
  });
  if (failedNotifs > 0) {
    alerts.push({
      priority: 'warning',
      type:     'notification_failures',
      message:  `${failedNotifs} notification(s) failed after max retries.`,
      count:    failedNotifs,
    });
  }

  // 4. Hospitals pending verification > 2 days
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60_000);
  const pendingVerification = await Hospital.count({
    where: { onboarding_status: OnboardingStatus.DOCUMENTS_SUBMITTED, updated_at: { [Op.lt]: twoDaysAgo } },
  });
  if (pendingVerification > 0) {
    alerts.push({
      priority: 'warning',
      type:     'pending_verification',
      message:  `${pendingVerification} hospital(s) awaiting document verification beyond SLA.`,
      count:    pendingVerification,
    });
  }

  return ok(alerts);
}

// ── Financial summary ─────────────────────────────────────────────────────────
export async function getFinancialSummary(period: 'today' | 'week' | 'month'): Promise<ServiceResponse<object>> {
  const now       = new Date();
  let periodStart: Date;

  if (period === 'today') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const [payments, refundCount] = await Promise.all([
    Payment.findAll({
      where: { status: PaymentGatewayStatus.CAPTURED, captured_at: { [Op.gte]: periodStart } },
      attributes: ['amount', 'platform_fee', 'doctor_payout'],
    }),
    Payment.count({ where: { status: PaymentGatewayStatus.REFUNDED, refunded_at: { [Op.gte]: periodStart } } }),
  ]);

  const gmv            = payments.reduce((s, p) => s + Number(p.amount), 0);
  const platformRevenue= payments.reduce((s, p) => s + Number(p.platform_fee), 0);
  const doctorPayouts  = payments.reduce((s, p) => s + Number(p.doctor_payout), 0);
  const takeRate       = gmv > 0 ? Math.round((platformRevenue / gmv) * 10000) / 100 : 0;

  return ok({
    period,
    period_start:      periodStart,
    total_transactions:payments.length,
    gmv:               Math.round(gmv * 100) / 100,
    platform_revenue:  Math.round(platformRevenue * 100) / 100,
    doctor_payouts:    Math.round(doctorPayouts * 100) / 100,
    take_rate_pct:     takeRate,
    refund_count:      refundCount,
    generated_at:      new Date(),
  });
}

// ── Doctor list with filters ──────────────────────────────────────────────────
export async function listDoctors(filters: {
  verification_status?: string;
  page: number; perPage: number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = {};
  if (filters.verification_status) where.verification_status = filters.verification_status;

  const { rows, count } = await DoctorProfile.findAndCountAll({
    where,
    include: [
      { model: User, as: 'user', attributes: ['mobile', 'account_status'] },
      {
        model: DoctorHospitalAffiliation,
        as: 'affiliations',
        where: { is_active: true },
        required: false,
        attributes: ['hospital_id', 'consultation_fee', 'is_primary', 'department', 'room_number'],
        include: [{ model: Hospital, as: 'hospital', attributes: ['id', 'name', 'city'] }],
      },
    ],
    order: [['created_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
    distinct: true,
  });
  return ok({ rows, count });
}

// ── Suspend / reactivate doctor ───────────────────────────────────────────────
export async function toggleDoctorStatus(
  doctorProfileId: string,
  action:          'suspend' | 'reactivate',
  adminId:         string,
): Promise<ServiceResponse<object>> {
  const doctor = await DoctorProfile.findByPk(doctorProfileId, {
    include: [{ model: User, as: 'user' }],
  });
  if (!doctor) throw ErrorFactory.notFound('DOCTOR_NOT_FOUND', 'Doctor not found.');

  const user = (doctor as unknown as { user: User }).user;
  const newStatus = action === 'suspend' ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
  await user.update({ account_status: newStatus });
  await doctor.update({ is_active: action === 'reactivate' });

  await AdminAuditLog.create({
    admin_id:      adminId,
    action:        action === 'suspend' ? AdminAction.DOCTOR_SUSPENDED : AdminAction.DOCTOR_REACTIVATED,
    resource_type: 'doctor',
    resource_id:   doctorProfileId,
    meta:          { account_status: newStatus },
    ip_address:    null,
  });

  logger.info(`Doctor ${action}d`, { doctorProfileId, adminId });
  return ok({ message: `Doctor ${action}d successfully.`, account_status: newStatus });
}

// ── Reliability score computation ─────────────────────────────────────────────
// Nightly batch job calls this for all doctors
export async function computeReliabilityScores(): Promise<ServiceResponse<{ updated: number }>> {
  const doctors = await DoctorProfile.findAll({
    where: { is_active: true, verification_status: VerificationStatus.APPROVED },
    attributes: ['id'],
  });

  let updated = 0;

  for (const doctor of doctors) {
    try {
      await computeSingleDoctorScore(doctor.id);
      updated++;
    } catch (err) {
      logger.error('Score computation failed', { doctorId: doctor.id, err });
    }
  }

  logger.info('Reliability scores computed', { updated });
  return ok({ updated });
}

async function computeSingleDoctorScore(doctorId: string): Promise<void> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000);

  const [totalAppts, completedAppts, cancelledDays, lateArrivals] = await Promise.all([
    Appointment.count({ where: { doctor_id: doctorId, scheduled_at: { [Op.gte]: ninetyDaysAgo } } }),
    Appointment.count({ where: { doctor_id: doctorId, status: AppointmentStatus.COMPLETED, scheduled_at: { [Op.gte]: ninetyDaysAgo } } }),
    DoctorDelayEvent.count({ where: { doctor_id: doctorId, event_date: { [Op.gte]: ninetyDaysAgo.toISOString().split('T')[0] }, status: DelayStatus.CANCELLED_DAY } }),
    ConsultationQueue.count({
      where: {
        doctor_id: doctorId, queue_date: { [Op.gte]: ninetyDaysAgo.toISOString().split('T')[0] },
        actual_start_at: { [Op.ne]: null },
      },
    }),
  ]);

  if (totalAppts === 0) return;

  const completionRate  = completedAppts / totalAppts;
  const onTimeRate      = lateArrivals > 0 ? Math.max(0, 1 - lateArrivals / Math.max(totalAppts / 5, 1)) : 0.95;
  const cancelRate      = Math.min(1, cancelledDays / 30);

  // Weighted score (0–100)
  const score = Math.round(
    (onTimeRate * 35 + (1 - cancelRate) * 30 + completionRate * 20 + 0.8 * 15) * 100,
  ) / 100;

  await DoctorProfile.update(
    { reliability_score: score, on_time_rate: onTimeRate, cancellation_rate: cancelRate, completion_rate: completionRate },
    { where: { id: doctorId } },
  );
}

// ── Verify / reject doctor ────────────────────────────────────────────────────
export async function verifyDoctor(
  doctorProfileId: string,
  action:          'approve' | 'reject',
  adminId:         string,
  notes?:          string,
): Promise<ServiceResponse<object>> {
  const doctor = await DoctorProfile.findByPk(doctorProfileId);
  if (!doctor) throw ErrorFactory.notFound('DOCTOR_NOT_FOUND', 'Doctor not found.');

  const newStatus = action === 'approve' ? VerificationStatus.APPROVED : VerificationStatus.REJECTED;
  await doctor.update({
    verification_status: newStatus,
    verified_by:         adminId,
    verified_at:         new Date(),
    ...(action === 'approve' ? { is_active: true } : {}),
  });

  await AdminAuditLog.create({
    admin_id:      adminId,
    action:        action === 'approve' ? AdminAction.DOCTOR_VERIFIED : AdminAction.DOCTOR_REJECTED,
    resource_type: 'doctor',
    resource_id:   doctorProfileId,
    meta:          { verification_status: newStatus, notes: notes ?? null },
    ip_address:    null,
  });

  logger.info(`Doctor verification ${action}d`, { doctorProfileId, adminId });
  return ok({ message: `Doctor ${action}d successfully.`, verification_status: newStatus });
}

// ── List hospitals ─────────────────────────────────────────────────────────────
export async function listHospitals(filters: {
  onboarding_status?: string;
  city?:              string;
  page:               number;
  perPage:            number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = {};
  if (filters.onboarding_status) where.onboarding_status = filters.onboarding_status;
  if (filters.city) where.city = filters.city;

  const { rows, count } = await Hospital.findAndCountAll({
    where,
    order: [['created_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
  });
  return ok({ rows, count });
}

// ── Hospital detail ───────────────────────────────────────────────────────────
export async function getHospitalDetail(hospitalId: string): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');

  const [doctorCount, staffCount, appointmentCount] = await Promise.all([
    DoctorHospitalAffiliation.count({ where: { hospital_id: hospitalId, is_active: true } }),
    HospitalStaff.count({ where: { hospital_id: hospitalId, is_active: true } }),
    Appointment.count({ where: { hospital_id: hospitalId } }),
  ]);

  return ok({ ...hospital.toJSON(), stats: { active_doctors: doctorCount, active_staff: staffCount, total_appointments: appointmentCount } });
}

// ── Update hospital status (suspend / activate) ───────────────────────────────
export async function updateHospitalStatus(
  hospitalId: string,
  action:     'suspend' | 'activate',
  adminId:    string,
  reason?:    string,
): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');

  const newStatus = action === 'suspend' ? OnboardingStatus.SUSPENDED : OnboardingStatus.LIVE;
  await hospital.update({
    onboarding_status: newStatus,
    ...(action === 'suspend'
      ? { suspended_at: new Date(), suspension_reason: reason ?? null }
      : { suspended_at: null, suspension_reason: null }),
  });

  await AdminAuditLog.create({
    admin_id:      adminId,
    action:        action === 'suspend' ? AdminAction.HOSPITAL_SUSPENDED : AdminAction.HOSPITAL_ACTIVATED,
    resource_type: 'hospital',
    resource_id:   hospitalId,
    meta:          { onboarding_status: newStatus, reason: reason ?? null },
    ip_address:    null,
  });

  logger.info(`Hospital ${action}d`, { hospitalId, adminId });
  return ok({ message: `Hospital ${action}d successfully.`, onboarding_status: newStatus });
}

// ── List patients ──────────────────────────────────────────────────────────────
export async function listPatients(filters: {
  account_status?: string;
  search?:         string;
  page:            number;
  perPage:         number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const userWhere: Record<string, unknown> = { role: UserRole.PATIENT };
  if (filters.account_status) userWhere.account_status = filters.account_status;

  const { rows, count } = await User.findAndCountAll({
    where: userWhere,
    include: [{
      model: PatientProfile, as: 'patientProfile',
      attributes: ['full_name', 'email', 'gender', 'profile_status'],
    }],
    order: [['created_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
  });
  return ok({ rows, count });
}

// ── Update patient status (suspend / activate) ────────────────────────────────
export async function updatePatientStatus(
  userId:   string,
  action:   'suspend' | 'activate',
  adminId:  string,
): Promise<ServiceResponse<object>> {
  const user = await User.findOne({ where: { id: userId, role: UserRole.PATIENT } });
  if (!user) throw ErrorFactory.notFound('PATIENT_NOT_FOUND', 'Patient not found.');

  const newStatus = action === 'suspend' ? AccountStatus.SUSPENDED : AccountStatus.ACTIVE;
  await user.update({ account_status: newStatus });

  await AdminAuditLog.create({
    admin_id:      adminId,
    action:        action === 'suspend' ? AdminAction.PATIENT_SUSPENDED : AdminAction.PATIENT_ACTIVATED,
    resource_type: 'patient',
    resource_id:   userId,
    meta:          { account_status: newStatus },
    ip_address:    null,
  });

  logger.info(`Patient ${action}d`, { userId, adminId });
  return ok({ message: `Patient ${action}d successfully.`, account_status: newStatus });
}

// ── List appointments (scoped) ────────────────────────────────────────────────
export async function listAppointments(filters: {
  hospital_id?: string;   // injected for HOSPITAL_ADMIN
  doctor_id?:   string;
  patient_id?:  string;
  status?:      string;
  date?:        string;   // YYYY-MM-DD
  page:         number;
  perPage:      number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = {};
  if (filters.hospital_id) where.hospital_id = filters.hospital_id;
  if (filters.doctor_id)   where.doctor_id   = filters.doctor_id;
  if (filters.patient_id)  where.patient_id  = filters.patient_id;
  if (filters.status)      where.status      = filters.status;
  if (filters.date) {
    const start = new Date(filters.date);
    const end   = new Date(filters.date);
    end.setDate(end.getDate() + 1);
    where.scheduled_at = { [Op.gte]: start, [Op.lt]: end };
  }

  const { rows, count } = await Appointment.findAndCountAll({
    where,
    include: [
      { model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] },
      { model: User,          as: 'patient', attributes: ['mobile'] },
    ],
    order: [['scheduled_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
  });
  return ok({ rows, count });
}

// ── Send appointment reminder push notification ───────────────────────────────
export async function sendAppointmentReminder(
  appointmentId: string,
  adminId: string,
): Promise<ServiceResponse<object>> {
  const appt = await Appointment.findByPk(appointmentId, {
    include: [
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name'] },
      { model: User,          as: 'patient',  attributes: ['id', 'mobile'] },
      { model: Hospital,      as: 'hospital', attributes: ['name'] },
    ],
  });
  if (!appt) return fail('APPOINTMENT_NOT_FOUND', 'Appointment not found.', 404);

  const notSendable = ['cancelled', 'completed', 'missed'];
  if (notSendable.includes(appt.status)) {
    return fail('INVALID_STATUS', `Cannot send reminder for a ${appt.status} appointment.`, 400);
  }

  const patient  = (appt as any).patient  as User;
  const doctor   = (appt as any).doctor   as DoctorProfile;
  const hospital = (appt as any).hospital as Hospital;

  const scheduledAt  = new Date(appt.scheduled_at);
  const hoursUntil   = Math.max(0, Math.round((scheduledAt.getTime() - Date.now()) / 3_600_000));

  await enqueueNotification({
    userId:        patient.id,
    type:          'appointment_reminder',
    channels:      [NotificationChannel.PUSH, NotificationChannel.SMS],
    priority:      'high',
    appointmentId,
    data: {
      mobile:   `+91${patient.mobile}`,
      name:     patient.mobile,
      doctor:   doctor?.full_name ?? 'Your Doctor',
      hospital: hospital?.name ?? 'the hospital',
      date:     scheduledAt.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
      time:     scheduledAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      token:    '—',
      hours:    hoursUntil,
    },
  });

  logger.info('Admin triggered appointment reminder', { appointmentId, adminId });
  return ok({ message: 'Reminder sent successfully.' });
}

// ── Scoped financial summary (with optional hospital scope) ───────────────────
export async function getScopedFinancialSummary(
  period:     'today' | 'week' | 'month',
  hospitalId?: string,
): Promise<ServiceResponse<object>> {
  const now = new Date();
  let periodStart: Date;
  if (period === 'today') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else if (period === 'week') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  }

  const apptWhere: Record<string, unknown> = {
    payment_status: PaymentStatus.CAPTURED,
    scheduled_at:   { [Op.gte]: periodStart },
  };
  if (hospitalId) apptWhere.hospital_id = hospitalId;

  const [appointments, refundCount] = await Promise.all([
    Appointment.findAll({ where: apptWhere, attributes: ['consultation_fee', 'platform_fee', 'doctor_payout'] }),
    Appointment.count({ where: { ...(hospitalId ? { hospital_id: hospitalId } : {}), payment_status: PaymentStatus.REFUNDED, scheduled_at: { [Op.gte]: periodStart } } }),
  ]);

  const gmv             = appointments.reduce((s, a) => s + Number(a.consultation_fee), 0);
  const platformRevenue = appointments.reduce((s, a) => s + Number(a.platform_fee), 0);
  const doctorPayouts   = appointments.reduce((s, a) => s + Number(a.doctor_payout), 0);
  const takeRate        = gmv > 0 ? Math.round((platformRevenue / gmv) * 10000) / 100 : 0;

  return ok({
    period, period_start: periodStart,
    total_transactions: appointments.length,
    gmv:               Math.round(gmv * 100) / 100,
    platform_revenue:  Math.round(platformRevenue * 100) / 100,
    doctor_payouts:    Math.round(doctorPayouts * 100) / 100,
    take_rate_pct:     takeRate,
    refund_count:      refundCount,
    generated_at:      new Date(),
  });
}

// ── Scoped doctor list ────────────────────────────────────────────────────────
export async function listDoctorsScoped(filters: {
  hospital_id?:        string;   // injected for HOSPITAL_ADMIN
  verification_status?: string;
  page:                number;
  perPage:             number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  if (filters.hospital_id) {
    // Scoped: find doctor IDs affiliated with this hospital
    const affiliations = await DoctorHospitalAffiliation.findAll({
      where: { hospital_id: filters.hospital_id, is_active: true },
      attributes: ['doctor_id'],
    });
    const doctorIds = affiliations.map(a => a.doctor_id);

    const where: Record<string, unknown> = { id: { [Op.in]: doctorIds } };
    if (filters.verification_status) where.verification_status = filters.verification_status;

    const { rows, count } = await DoctorProfile.findAndCountAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['mobile', 'account_status'] },
        {
          model: DoctorHospitalAffiliation,
          as: 'affiliations',
          where: { is_active: true },
          required: false,
          attributes: ['hospital_id', 'consultation_fee', 'is_primary', 'department', 'room_number'],
          include: [{ model: Hospital, as: 'hospital', attributes: ['id', 'name', 'city'] }],
        },
      ],
      order: [['created_at', 'DESC']],
      limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
      distinct: true,
    });
    return ok({ rows, count });
  }

  return listDoctors(filters);
}

// ── List hospital staff ───────────────────────────────────────────────────────
export async function listHospitalStaff(
  hospitalId: string,
  page = 1,
  perPage = 20,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await HospitalStaff.findAndCountAll({
    where: { hospital_id: hospitalId },
    include: [{ model: User, as: 'user', attributes: ['mobile', 'account_status', 'last_login_at'] }],
    order: [['created_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}

// ── Audit logs ────────────────────────────────────────────────────────────────
export async function getAuditLogs(filters: {
  admin_id?:     string;
  resource_type?: string;
  action?:       string;
  page:          number;
  perPage:       number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = {};
  if (filters.admin_id)      where.admin_id      = filters.admin_id;
  if (filters.resource_type) where.resource_type = filters.resource_type;
  if (filters.action)        where.action        = filters.action;

  const { rows, count } = await AdminAuditLog.findAndCountAll({
    where,
    include: [{ model: User, as: 'admin', attributes: ['mobile'] }],
    order: [['created_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
  });
  return ok({ rows, count });
}

// ── Set primary hospital for a doctor ────────────────────────────────────────
export async function setPrimaryHospital(
  doctorId:   string,
  hospitalId: string,
  adminId:    string,
): Promise<ServiceResponse<object>> {
  const affil = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });
  if (!affil) return fail('AFFILIATION_NOT_FOUND', 'Doctor is not affiliated with this hospital.', 404);

  // Clear current primary, then set new one
  await DoctorHospitalAffiliation.update(
    { is_primary: false },
    { where: { doctor_id: doctorId } },
  );
  await affil.update({ is_primary: true });

  await AdminAuditLog.create({
    admin_id:      adminId,
    action:        AdminAction.DOCTOR_REACTIVATED, // reuse closest existing action
    resource_type: 'doctor_affiliation',
    resource_id:   doctorId,
    meta:          { set_primary_hospital: hospitalId },
    ip_address:    null,
  });

  return ok({ message: 'Primary hospital updated.', hospital_id: hospitalId });
}

// ── Per-doctor analytics stats ────────────────────────────────────────────────
export async function getDoctorStats(doctorId: string): Promise<ServiceResponse<object>> {
  const doctor = await DoctorProfile.findByPk(doctorId, {
    attributes: ['full_name', 'reliability_score', 'on_time_rate', 'cancellation_rate', 'completion_rate', 'avg_consultation_minutes'],
  });
  if (!doctor) return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);

  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60_000);

  const { DoctorReview } = await import('../../models');

  const [totalAppointments, completedAppointments, cancelledAppointments, reviewRow] = await Promise.all([
    Appointment.count({ where: { doctor_id: doctorId, scheduled_at: { [Op.gte]: ninetyDaysAgo } } }),
    Appointment.count({ where: { doctor_id: doctorId, status: AppointmentStatus.COMPLETED, scheduled_at: { [Op.gte]: ninetyDaysAgo } } }),
    Appointment.count({ where: { doctor_id: doctorId, status: AppointmentStatus.CANCELLED, scheduled_at: { [Op.gte]: ninetyDaysAgo } } }),
    DoctorReview.findOne({
      where: { doctor_id: doctorId },
      attributes: [
        [DoctorReview.sequelize!.fn('AVG', DoctorReview.sequelize!.col('rating')), 'avg_rating'],
        [DoctorReview.sequelize!.fn('COUNT', DoctorReview.sequelize!.col('id')),   'review_count'],
      ],
      raw: true,
    }),
  ]);

  const avg_rating   = Math.round((parseFloat((reviewRow as any)?.avg_rating  ?? '0') || 0) * 10) / 10;
  const review_count = parseInt((reviewRow as any)?.review_count ?? '0', 10);

  return ok({
    total_appointments_90d:   totalAppointments,
    completed_appointments:   completedAppointments,
    cancelled_appointments:   cancelledAppointments,
    completion_rate:          Number(doctor.completion_rate  ?? 0),
    cancellation_rate:        Number(doctor.cancellation_rate ?? 0),
    on_time_rate:             Number(doctor.on_time_rate     ?? 0),
    avg_consultation_minutes: Number(doctor.avg_consultation_minutes ?? 0),
    reliability_score:        Number(doctor.reliability_score ?? 0),
    avg_rating,
    review_count,
  });
}

// ── Revenue time-series (for chart) ──────────────────────────────────────────
export async function getRevenueTimeSeries(
  period: 'today' | 'week' | 'month',
): Promise<ServiceResponse<object[]>> {
  const now = new Date();
  let periodStart: Date;
  let groupExpr: string;
  let labelFormat: string;

  if (period === 'today') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    groupExpr   = "date_trunc('hour', captured_at)";
    labelFormat = 'HH24":00"';
  } else if (period === 'week') {
    periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    groupExpr   = "date_trunc('day', captured_at)";
    labelFormat = 'Dy';
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    groupExpr   = "date_trunc('day', captured_at)";
    labelFormat = 'DD Mon';
  }

  const rows = await sequelize.query<{
    label: string; gmv: string; revenue: string; transactions: string;
  }>(
    `SELECT
       to_char(${groupExpr}, :labelFormat) AS label,
       COALESCE(SUM(amount::numeric),       0) AS gmv,
       COALESCE(SUM(platform_fee::numeric), 0) AS revenue,
       COUNT(*)                                AS transactions
     FROM payments
     WHERE status = 'captured' AND captured_at >= :periodStart
     GROUP BY ${groupExpr}
     ORDER BY ${groupExpr}`,
    { replacements: { periodStart, labelFormat }, type: QueryTypes.SELECT },
  );

  return ok(
    rows.map(r => ({
      label:        r.label.trim(),
      gmv:          parseFloat(r.gmv),
      revenue:      parseFloat(r.revenue),
      transactions: parseInt(r.transactions, 10),
    })),
  );
}

// ── Increment Redis live counters ─────────────────────────────────────────────
export async function incrementCounter(key: string, amount = 1): Promise<void> {
  const fullKey = `stats:today:${key}`;
  await redis.incrby(fullKey, amount);

  // Set expiry to end of day if key is new
  const ttl = await redis.ttl(fullKey);
  if (ttl < 0) {
    const secondsUntilMidnight = Math.floor(
      (new Date(new Date().toDateString()).getTime() + 86_400_000 - Date.now()) / 1000,
    );
    await redis.expire(fullKey, secondsUntilMidnight + 3600); // 1 hour buffer
  }
}
