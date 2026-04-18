import { Queue, Worker, Job } from 'bullmq';
import { env }                from '../../config/env';
import { logger }             from '../../utils/logger';

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT, ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}) };

// ── Job types ─────────────────────────────────────────────────────────────────
type CronJobType =
  | 'generate_slots'
  | 'draft_next_day_slots'
  | 'send_review_reminder'
  | 'auto_publish_unreviewed_slots'
  | 'expire_waitlist_offers'
  | 'aggregate_daily_stats'
  | 'refresh_search_index'
  | 'compute_reliability_scores'
  | 'archive_daily_stats'
  | 'expire_approval_timeouts';

// ── Cron queue ────────────────────────────────────────────────────────────────
export const cronQueue = new Queue<{ type: CronJobType }>('cron', {
  connection,
  defaultJobOptions: { attempts: 3, backoff: { type: 'fixed', delay: 60_000 }, removeOnComplete: 10, removeOnFail: 50 },
});

// ── Schedule all cron jobs ────────────────────────────────────────────────────
export async function scheduleCronJobs(): Promise<void> {
  // Remove existing repeatable jobs first (idempotent)
  const existing = await cronQueue.getRepeatableJobs();
  for (const job of existing) {
    await cronQueue.removeRepeatableByKey(job.key);
  }

  // Phase 12: generate_slots cron REMOVED — replaced by draft_next_day_slots + publish governance flow
  // The handler is retained for manual/emergency use via direct queue push only.

  // Phase 2 — Slot Governance (IST times → UTC)
  // 6:00 PM IST = 12:30 UTC
  await cronQueue.add('draft_next_day_slots',          { type: 'draft_next_day_slots' },          { repeat: { pattern: '30 12 * * *' } });
  // 7:00 PM IST = 13:30 UTC
  await cronQueue.add('send_review_reminder',          { type: 'send_review_reminder' },          { repeat: { pattern: '30 13 * * *' } });
  // 9:00 PM IST = 15:30 UTC
  await cronQueue.add('auto_publish_unreviewed_slots', { type: 'auto_publish_unreviewed_slots' }, { repeat: { pattern: '30 15 * * *' } });

  // Phase 7 — Waitlist + Analytics
  // Expire waitlist offers every 5 minutes
  await cronQueue.add('expire_waitlist_offers', { type: 'expire_waitlist_offers' }, { repeat: { pattern: '*/5 * * * *' } });
  // 11:55 PM IST = 18:25 UTC — aggregate yesterday's stats before midnight
  await cronQueue.add('aggregate_daily_stats',  { type: 'aggregate_daily_stats' },  { repeat: { pattern: '25 18 * * *' } });

  await cronQueue.add('refresh_search_index',     { type: 'refresh_search_index' },     { repeat: { pattern: '35 20 * * *' } });
  await cronQueue.add('compute_reliability_scores',{ type: 'compute_reliability_scores' },{ repeat: { pattern: '40 20 * * *' } });
  await cronQueue.add('archive_daily_stats',       { type: 'archive_daily_stats' },      { repeat: { pattern: '55 23 * * *' } }); // 5:25 AM IST

  // Also refresh search index every 5 minutes (availability counts)
  await cronQueue.add('refresh_search_index_5min', { type: 'refresh_search_index' },    { repeat: { pattern: '*/5 * * * *' } });

  // Phase 8 — expire doctor approval timeouts every 10 minutes
  await cronQueue.add('expire_approval_timeouts', { type: 'expire_approval_timeouts' }, { repeat: { pattern: '*/10 * * * *' } });

  logger.info('⏰  Cron jobs scheduled');
}

// ── Worker processor ──────────────────────────────────────────────────────────
async function processJob(job: Job<{ type: CronJobType }>): Promise<void> {
  const { type } = job.data;
  logger.info(`Cron job started: ${type}`);

  switch (type) {
    case 'draft_next_day_slots': {
      const { Hospital }                = await import('../../models');
      const { draftSlotsForDate }       = await import('../governance/governance.service');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = tomorrow.toISOString().split('T')[0];

      const hospitals = await Hospital.findAll({
        where: { onboarding_status: 'live' },
        attributes: ['id'],
      });

      let totalDrafted = 0, errors = 0;
      for (const hospital of hospitals) {
        try {
          const result = await draftSlotsForDate(hospital.id, date);
          if (result.success) totalDrafted += result.data.total_slots;
        } catch (err) {
          errors++;
          logger.error('Draft slots error', { hospitalId: hospital.id, date, err });
        }
      }
      logger.info('Draft next-day slots complete', { date, totalDrafted, errors });
      break;
    }

    case 'send_review_reminder': {
      const { Hospital }    = await import('../../models');
      const { OpdReviewLog } = await import('../../models');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = tomorrow.toISOString().split('T')[0];

      // Find hospitals that have draft slots but no review log yet
      const { OpdSlotSession, OpdSlotStatus: SlotStatusEnum } = await import('../../models');
      const { Op } = await import('sequelize');

      const reviewed = await OpdReviewLog.findAll({
        where: { date },
        attributes: ['hospital_id'],
      });
      const reviewedIds = new Set(reviewed.map((r) => r.hospital_id));

      const pending = await OpdSlotSession.findAll({
        where: { date, status: SlotStatusEnum.DRAFT },
        attributes: ['hospital_id'],
        group: ['hospital_id'],
      });

      const toRemind = pending.filter((p) => !reviewedIds.has(p.hospital_id));
      logger.warn('Review reminder — hospitals with unreviewed draft slots', {
        date,
        count: toRemind.length,
        hospitalIds: toRemind.map((p) => p.hospital_id),
      });
      // TODO Phase 4: send actual SMS/notification to receptionist
      break;
    }

    case 'auto_publish_unreviewed_slots': {
      const { Hospital }             = await import('../../models');
      const { autoPublishUnreviewed } = await import('../governance/governance.service');

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const date = tomorrow.toISOString().split('T')[0];

      const hospitals = await Hospital.findAll({
        where: { onboarding_status: 'live' },
        attributes: ['id'],
      });

      let totalPublished = 0;
      for (const hospital of hospitals) {
        try {
          const result = await autoPublishUnreviewed(hospital.id, date);
          if (result.success) totalPublished += result.data.published;
        } catch (err) {
          logger.error('Auto-publish error', { hospitalId: hospital.id, date, err });
        }
      }
      logger.info('Auto-publish unreviewed slots complete', { date, totalPublished });
      break;
    }

    case 'generate_slots': {
      const { DoctorHospitalAffiliation } = await import('../../models');
      const { generateSlotsForDoctor }    = await import('../schedules/schedule.service');

      const affiliations = await DoctorHospitalAffiliation.findAll({ where: { is_active: true } });
      let generated = 0, errors = 0;

      const today     = new Date();
      const toDateObj = new Date(today);
      toDateObj.setDate(today.getDate() + env.SLOT_GENERATION_DAYS_AHEAD);
      const fromDate  = today.toISOString().split('T')[0];
      const toDate    = toDateObj.toISOString().split('T')[0];

      for (const aff of affiliations) {
        try {
          const result = await generateSlotsForDoctor(aff.doctor_id, aff.hospital_id, fromDate, toDate);
          if (result.success) generated += result.data.generated;
        } catch (err) {
          errors++;
          logger.error('Slot generation error', { doctorId: aff.doctor_id, err });
        }
      }

      logger.info('Slot generation complete', { generated, errors });
      break;
    }

    case 'expire_waitlist_offers': {
      const { expireWaitlistOffers } = await import('../waitlist/waitlist.service');
      const result = await expireWaitlistOffers();
      if (result.expired > 0) logger.info('Waitlist offers expired by cron', result);
      break;
    }

    case 'aggregate_daily_stats': {
      const { aggregateDailyStats } = await import('../analytics/analytics.service');
      const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().split('T')[0];
      const result = await aggregateDailyStats(yesterday);
      if (result.success) logger.info('Daily OPD stats aggregated', result.data);
      break;
    }

    case 'refresh_search_index': {
      const { rebuildFullIndex } = await import('../search/search.service');
      const result = await rebuildFullIndex();
      logger.info('Search index refresh complete', result);
      break;
    }

    case 'compute_reliability_scores': {
      const { computeReliabilityScores } = await import('../admin/admin.service');
      const result = await computeReliabilityScores();
      if (result.success) logger.info('Reliability scores updated', result.data);
      break;
    }

    case 'archive_daily_stats': {
      const { redis }     = await import('../../config/redis');
      const { sequelize } = await import('../../config/database');

      // Read today's counters before they expire
      const yesterday = new Date(Date.now() - 24 * 60 * 60_000).toISOString().split('T')[0];
      const keys = [
        'stats:today:bookings',
        'stats:today:cancellations',
        'stats:today:registrations',
        'stats:today:sms:sent',
        'stats:today:sms:delivered',
        'stats:today:payments:success',
        'stats:today:payments:failed',
      ];

      const values = await Promise.all(keys.map(k => redis.get(k)));
      const [bookings, cancellations, registrations, smsSent, smsDelivered, paymentsSuccess, paymentsFailed] = values.map(v => parseInt(v ?? '0', 10));

      await sequelize.query(
        `INSERT INTO daily_platform_stats
           (stat_date, bookings, cancellations, registrations, sms_sent, sms_delivered, payments_success, payments_failed, created_at)
         VALUES (:date, :bookings, :cancellations, :registrations, :smsSent, :smsDelivered, :paymentsSuccess, :paymentsFailed, NOW())
         ON CONFLICT (stat_date) DO UPDATE SET
           bookings = EXCLUDED.bookings,
           cancellations = EXCLUDED.cancellations`,
        {
          replacements: { date: yesterday, bookings, cancellations, registrations, smsSent, smsDelivered, paymentsSuccess, paymentsFailed },
        },
      );

      logger.info('Daily stats archived', { date: yesterday, bookings, cancellations });
      break;
    }

    case 'expire_approval_timeouts': {
      const { sequelize: seq } = await import('../../config/database');
      const { Appointment, AppointmentStatus, DoctorBookingPreference, GeneratedSlot, SlotStatus } = await import('../../models');
      const { Op } = await import('sequelize');

      // Find appointments awaiting approval where doctor preference timeout has passed
      const prefs = await DoctorBookingPreference.findAll({
        where: { requires_booking_approval: true },
        attributes: ['doctor_id', 'hospital_id', 'approval_timeout_hours'],
      });

      let expired = 0;
      for (const pref of prefs) {
        if (!pref.approval_timeout_hours) continue;
        const cutoff = new Date(Date.now() - pref.approval_timeout_hours * 60 * 60 * 1000);
        const timedOut = await Appointment.findAll({
          where: {
            doctor_id:   pref.doctor_id,
            hospital_id: pref.hospital_id,
            status:      AppointmentStatus.AWAITING_HOSPITAL_APPROVAL,
            created_at:  { [Op.lt]: cutoff },
          },
          attributes: ['id', 'slot_id'],
        });

        for (const appt of timedOut) {
          try {
            await seq.transaction(async (t) => {
              await appt.update({ status: AppointmentStatus.CANCELLED, cancellation_reason: 'Approval timeout', cancelled_at: new Date() }, { transaction: t });
              if (appt.slot_id) {
                await GeneratedSlot.update({ status: SlotStatus.AVAILABLE, appointment_id: null }, { where: { id: appt.slot_id }, transaction: t });
              }
            });
            expired++;
          } catch (err) {
            logger.error('Approval timeout expiry error', { appointmentId: appt.id, err });
          }
        }
      }

      if (expired > 0) logger.info('Approval timeouts expired', { expired });
      break;
    }

    default:
      logger.warn('Unknown cron job type', { type });
  }
}

// ── Start cron worker ─────────────────────────────────────────────────────────
export function startCronWorker(): Worker {
  const worker = new Worker<{ type: CronJobType }>('cron', processJob, {
    connection,
    concurrency: 1,  // cron jobs run serially to avoid DB overload
  });

  worker.on('completed', (job) => logger.info(`Cron job completed: ${job.data.type}`));
  worker.on('failed',    (job, err) => logger.error(`Cron job failed: ${job?.data.type}`, { err }));

  logger.info('⏰  Cron worker started');
  return worker;
}
