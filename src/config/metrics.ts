import client from 'prom-client';
import { logger } from '../utils/logger';

// ── Default Node.js process metrics (memory, CPU, event loop lag) ─────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });

// ── Application-level counters ────────────────────────────────────────────────
export const httpRequestsTotal = new client.Counter({
  name:    'http_requests_total',
  help:    'Total HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

export const httpRequestDuration = new client.Histogram({
  name:    'http_request_duration_seconds',
  help:    'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets:    [0.005, 0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
  registers:  [register],
});

export const bookingsTotal = new client.Counter({
  name:    'bookings_total',
  help:    'Total appointments booked',
  registers: [register],
});

export const notificationQueueSize = new client.Gauge({
  name:    'notification_queue_size',
  help:    'Current notification queue depth',
  registers: [register],
});

export const bullmqFailedJobs = new client.Counter({
  name:    'bullmq_failed_jobs_total',
  help:    'Total BullMQ jobs that failed after all retries',
  labelNames: ['queue'],
  registers:  [register],
});

export const activeOpdSessions = new client.Gauge({
  name:    'opd_active_sessions',
  help:    'Number of currently active OPD sessions',
  registers: [register],
});

export { register };

export function getMetrics(): Promise<string> {
  return register.metrics();
}

export function getContentType(): string {
  return register.contentType;
}

logger.info('Prometheus metrics registry initialised');
