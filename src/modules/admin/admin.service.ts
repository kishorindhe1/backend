import { Op }                          from 'sequelize';
import { sequelize }                    from '../../config/database';
import { redis }                        from '../../config/redis';
import {
  User,
  DoctorProfile, VerificationStatus,
  Hospital, OnboardingStatus,
  Appointment, AppointmentStatus, PaymentStatus,
  Payment, PaymentGatewayStatus,
  ConsultationQueue, QueueStatus,
  DoctorDelayEvent, DelayStatus,
  NotificationLog, NotificationStatus,
}                                       from '../../models';
import { UserRole, AccountStatus } from '../../types';
import { ErrorFactory }                 from '../../utils/errors';
import { ServiceResponse, ok, fail }    from '../../types';
import { logger }                       from '../../utils/logger';

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
    include: [{ model: User, as: 'user', attributes: ['mobile', 'account_status'] }],
    order: [['created_at', 'DESC']],
    limit: filters.perPage, offset: (filters.page - 1) * filters.perPage,
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
