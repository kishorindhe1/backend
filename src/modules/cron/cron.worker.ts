import { Queue, Worker, Job } from 'bullmq';
import { env }                from '../../config/env';
import { logger }             from '../../utils/logger';

const connection = { host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD };

// ── Job types ─────────────────────────────────────────────────────────────────
type CronJobType =
  | 'generate_slots'
  | 'refresh_search_index'
  | 'compute_reliability_scores'
  | 'archive_daily_stats';

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

  // Nightly 2 AM IST (UTC+5:30 → 20:30 UTC)
  await cronQueue.add('generate_slots',           { type: 'generate_slots' },           { repeat: { pattern: '30 20 * * *' } });
  await cronQueue.add('refresh_search_index',     { type: 'refresh_search_index' },     { repeat: { pattern: '35 20 * * *' } });
  await cronQueue.add('compute_reliability_scores',{ type: 'compute_reliability_scores' },{ repeat: { pattern: '40 20 * * *' } });
  await cronQueue.add('archive_daily_stats',       { type: 'archive_daily_stats' },      { repeat: { pattern: '55 23 * * *' } }); // 5:25 AM IST

  // Also refresh search index every 5 minutes (availability counts)
  await cronQueue.add('refresh_search_index_5min', { type: 'refresh_search_index' },    { repeat: { pattern: '*/5 * * * *' } });

  // Run slot generation immediately on startup to fill any gaps
  await cronQueue.add('generate_slots_startup', { type: 'generate_slots' }, { jobId: 'startup_slots' });

  logger.info('⏰  Cron jobs scheduled');
}

// ── Worker processor ──────────────────────────────────────────────────────────
async function processJob(job: Job<{ type: CronJobType }>): Promise<void> {
  const { type } = job.data;
  logger.info(`Cron job started: ${type}`);

  switch (type) {
    case 'generate_slots': {
      const { DoctorHospitalAffiliation } = await import('../../models');
      const { generateSlotsForDoctor }    = await import('../schedules/schedule.service');

      const affiliations = await DoctorHospitalAffiliation.findAll({ where: { is_active: true } });
      let generated = 0, errors = 0;

      for (const aff of affiliations) {
        try {
          const result = await generateSlotsForDoctor(aff.doctor_id, aff.hospital_id, env.SLOT_GENERATION_DAYS_AHEAD);
          if (result.success) generated += result.data.generated;
        } catch (err) {
          errors++;
          logger.error('Slot generation error', { doctorId: aff.doctor_id, err });
        }
      }

      logger.info('Slot generation complete', { generated, errors });
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
