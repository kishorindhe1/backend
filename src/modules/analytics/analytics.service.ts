import { Op }                       from 'sequelize';
import {
  OpdSlotSession, OpdSlotStatus,
  OpdDailyStats,
  Appointment, AppointmentStatus,
  NoShowLog,
  WalkInToken,
  ConsultationQueue, QueueStatus,
  DoctorDelayEvent, DelayStatus,
  DoctorHospitalAffiliation,
}                                    from '../../models';
import { ServiceResponse, ok }       from '../../types';
import { logger }                    from '../../utils/logger';

// ── Aggregate daily stats for a single hospital/doctor/date ──────────────────

async function aggregateForDoctor(
  hospitalId: string,
  doctorId:   string,
  date:       string,
): Promise<void> {
  const [slots, appointments, noShows, walkIns, queueEntries, delayEvents] = await Promise.all([
    OpdSlotSession.findAll({
      where: { hospital_id: hospitalId, doctor_id: doctorId, date },
      attributes: ['status', 'walk_in_token_id'],
    }),
    Appointment.findAll({
      where: {
        hospital_id: hospitalId,
        doctor_id:   doctorId,
        scheduled_at: {
          [Op.between]: [new Date(`${date}T00:00:00`), new Date(`${date}T23:59:59`)],
        },
      },
      attributes: ['status', 'consultation_fee'],
    }),
    NoShowLog.count({ where: { doctor_id: doctorId } }),
    WalkInToken.count({ where: { doctor_id: doctorId, hospital_id: hospitalId, date } }),
    ConsultationQueue.findAll({
      where: { doctor_id: doctorId, hospital_id: hospitalId, queue_date: date },
      attributes: ['status', 'actual_start_at', 'estimated_start_at', 'actual_end_at'],
    }),
    DoctorDelayEvent.findAll({
      where: { doctor_id: doctorId, hospital_id: hospitalId, event_date: date, status: DelayStatus.RESOLVED },
      attributes: ['delay_minutes'],
    }),
  ]);

  const published   = slots.filter((s) => s.status !== OpdSlotStatus.CANCELLED).length;
  const booked      = slots.filter((s) => s.status === OpdSlotStatus.BOOKED).length;
  const completed   = slots.filter((s) => s.status === OpdSlotStatus.COMPLETED).length;
  const cancellations = appointments.filter((a) => a.status === AppointmentStatus.CANCELLED).length;
  const revenue     = appointments
    .filter((a) => a.status === AppointmentStatus.COMPLETED)
    .reduce((sum, a) => sum + Number(a.consultation_fee ?? 0), 0);

  const utilisationRate = published > 0 ? Math.round((booked / published) * 100 * 100) / 100 : 0;

  // Average delay across resolved events
  const avgDelay = delayEvents.length > 0
    ? delayEvents.reduce((s, e) => s + (e.delay_minutes ?? 0), 0) / delayEvents.length
    : 0;

  // Average wait: difference between actual_start and estimated_start for completed queue entries
  const waitTimes = queueEntries
    .filter((q) => q.actual_start_at && q.estimated_start_at && q.status === QueueStatus.COMPLETED)
    .map((q) => (q.actual_start_at!.getTime() - q.estimated_start_at!.getTime()) / 60_000);
  const avgWait = waitTimes.length > 0 ? waitTimes.reduce((s, w) => s + w, 0) / waitTimes.length : 0;

  await OpdDailyStats.upsert({
    hospital_id:           hospitalId,
    doctor_id:             doctorId,
    date,
    total_slots_published: published,
    total_booked:          booked,
    total_walk_ins:        walkIns,
    total_no_shows:        noShows,
    total_cancellations:   cancellations,
    total_completed:       completed,
    utilisation_rate:      utilisationRate,
    avg_delay_minutes:     Math.round(avgDelay * 100) / 100,
    avg_wait_minutes:      Math.round(avgWait  * 100) / 100,
    revenue_collected:     revenue,
  });
}

// ── Aggregate all doctors for a hospital/date ─────────────────────────────────

export async function aggregateDailyStats(
  date: string,
): Promise<ServiceResponse<{ processed: number; errors: number }>> {
  const affiliations = await DoctorHospitalAffiliation.findAll({
    where: { is_active: true },
    attributes: ['doctor_id', 'hospital_id'],
  });

  let processed = 0;
  let errors    = 0;

  for (const aff of affiliations) {
    try {
      await aggregateForDoctor(aff.hospital_id, aff.doctor_id, date);
      processed++;
    } catch (err) {
      errors++;
      logger.error('Daily stats aggregation error', { doctorId: aff.doctor_id, hospitalId: aff.hospital_id, date, err });
    }
  }

  logger.info('Daily stats aggregated', { date, processed, errors });
  return ok({ processed, errors });
}

// ── Get stats for admin panel ─────────────────────────────────────────────────

export async function getHospitalStats(
  hospitalId: string,
  fromDate:   string,
  toDate:     string,
  doctorId?:  string,
): Promise<ServiceResponse<object[]>> {
  const where: Record<string, unknown> = {
    hospital_id: hospitalId,
    date: { [Op.between]: [fromDate, toDate] },
  };
  if (doctorId) where.doctor_id = doctorId;

  const stats = await OpdDailyStats.findAll({
    where,
    order: [['date', 'ASC']],
  });
  return ok(stats.map((s) => s.toJSON()));
}

// ── Punctuality report ────────────────────────────────────────────────────────
// Returns per-doctor punctuality: on-time %, avg delay, worst delay for a date range.

export async function getPunctualityReport(
  hospitalId: string,
  fromDate:   string,
  toDate:     string,
): Promise<ServiceResponse<object[]>> {
  const stats = await OpdDailyStats.findAll({
    where: {
      hospital_id: hospitalId,
      date: { [Op.between]: [fromDate, toDate] },
    },
    attributes: ['doctor_id', 'date', 'avg_delay_minutes'],
    order: [['date', 'ASC']],
  });

  // Group by doctor_id
  const byDoctor = new Map<string, number[]>();
  for (const s of stats) {
    const arr = byDoctor.get(s.doctor_id) ?? [];
    arr.push(Number(s.avg_delay_minutes ?? 0));
    byDoctor.set(s.doctor_id, arr);
  }

  const report = Array.from(byDoctor.entries()).map(([doctorId, delays]) => {
    const avg     = delays.reduce((s, d) => s + d, 0) / delays.length;
    const onTime  = delays.filter((d) => d <= 5).length;
    const worst   = Math.max(...delays);
    return {
      doctor_id:             doctorId,
      days_tracked:          delays.length,
      avg_delay_minutes:     Math.round(avg * 100) / 100,
      on_time_pct:           Math.round((onTime / delays.length) * 100),
      worst_delay_minutes:   worst,
    };
  });

  report.sort((a, b) => b.avg_delay_minutes - a.avg_delay_minutes);
  return ok(report);
}

// ── Utilisation trend ─────────────────────────────────────────────────────────
// Returns daily utilisation % aggregated across all doctors for a hospital.

export async function getUtilisationTrend(
  hospitalId: string,
  fromDate:   string,
  toDate:     string,
): Promise<ServiceResponse<{ date: string; avg_utilisation: number; total_booked: number; total_published: number }[]>> {
  const stats = await OpdDailyStats.findAll({
    where: {
      hospital_id: hospitalId,
      date: { [Op.between]: [fromDate, toDate] },
    },
    attributes: ['date', 'utilisation_rate', 'total_booked', 'total_slots_published'],
    order: [['date', 'ASC']],
  });

  const byDate = new Map<string, { rates: number[]; booked: number; published: number }>();
  for (const s of stats) {
    const entry = byDate.get(s.date) ?? { rates: [], booked: 0, published: 0 };
    entry.rates.push(Number(s.utilisation_rate ?? 0));
    entry.booked    += Number(s.total_booked ?? 0);
    entry.published += Number(s.total_slots_published ?? 0);
    byDate.set(s.date, entry);
  }

  const trend = Array.from(byDate.entries()).map(([date, { rates, booked, published }]) => ({
    date,
    avg_utilisation: Math.round(rates.reduce((s, r) => s + r, 0) / rates.length * 100) / 100,
    total_booked:    booked,
    total_published: published,
  }));

  return ok(trend);
}

// ── Gap efficiency report ─────────────────────────────────────────────────────
// Ratio of walk-in + gap-booked slots vs total published for gap-based doctors.

export async function getGapEfficiencyReport(
  hospitalId: string,
  fromDate:   string,
  toDate:     string,
): Promise<ServiceResponse<object[]>> {
  const stats = await OpdDailyStats.findAll({
    where: {
      hospital_id: hospitalId,
      date: { [Op.between]: [fromDate, toDate] },
    },
    attributes: ['doctor_id', 'date', 'total_walk_ins', 'total_booked', 'total_slots_published', 'avg_wait_minutes'],
    order: [['date', 'ASC']],
  });

  const byDoctor = new Map<string, { walkIns: number; booked: number; published: number; waitTimes: number[] }>();
  for (const s of stats) {
    const entry = byDoctor.get(s.doctor_id) ?? { walkIns: 0, booked: 0, published: 0, waitTimes: [] };
    entry.walkIns   += Number(s.total_walk_ins ?? 0);
    entry.booked    += Number(s.total_booked ?? 0);
    entry.published += Number(s.total_slots_published ?? 0);
    if (s.avg_wait_minutes) entry.waitTimes.push(Number(s.avg_wait_minutes));
    byDoctor.set(s.doctor_id, entry);
  }

  const report = Array.from(byDoctor.entries()).map(([doctorId, { walkIns, booked, published, waitTimes }]) => ({
    doctor_id:           doctorId,
    total_walk_ins:      walkIns,
    total_booked:        booked,
    total_published:     published,
    gap_fill_rate:       published > 0 ? Math.round((booked / published) * 100) : 0,
    walk_in_pct:         booked > 0 ? Math.round((walkIns / booked) * 100) : 0,
    avg_wait_minutes:    waitTimes.length > 0
      ? Math.round(waitTimes.reduce((s, w) => s + w, 0) / waitTimes.length * 100) / 100
      : 0,
  }));

  report.sort((a, b) => b.gap_fill_rate - a.gap_fill_rate);
  return ok(report);
}
