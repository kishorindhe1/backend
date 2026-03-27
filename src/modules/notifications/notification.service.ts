import { Queue, Worker, Job } from 'bullmq';
import { sendSMS, sendPush, sendEmail } from '../../utils/smsProvider';
import { renderNotification }           from '../../utils/notificationTemplates';
import { env }                from '../../config/env';
import {
  NotificationLog, NotificationChannel, NotificationStatus,
  UserNotificationPreference,
}                             from '../../models';
import { logger }             from '../../utils/logger';
import { ServiceResponse, ok } from '../../types';

// ── BullMQ queue (uses same Redis connection) ─────────────────────────────────
const queueConnection = { host: env.REDIS_HOST, port: env.REDIS_PORT, password: env.REDIS_PASSWORD };

export const notificationQueue = new Queue('notifications', {
  connection: queueConnection,
  defaultJobOptions: { attempts: 5, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 100, removeOnFail: 500 },
});

// ── Job payload type ──────────────────────────────────────────────────────────
export interface NotificationJobPayload {
  userId:          string;
  appointmentId?:  string;
  type:            string;             // 'booking_confirmed' | 'doctor_late' | etc.
  channels:        NotificationChannel[];
  priority:        'critical' | 'high' | 'medium' | 'low';
  data:            Record<string, unknown>;
}

// ── Quiet-hours bypass config (kept here so service controls business logic) ──
const BYPASS_QUIET_HOURS: Record<string, boolean> = {
  otp:                       true,
  booking_confirmed:         false,
  booking_cancelled_doctor:  true,
  booking_cancelled_patient: false,
  doctor_late:               false,
  doctor_absent:             true,
  queue_position_alert:      false,
  payment_successful:        false,
  refund_initiated:          false,
  appointment_reminder:      false,
};

// ── Enqueue a notification ────────────────────────────────────────────────────
export async function enqueueNotification(payload: NotificationJobPayload): Promise<void> {
  const priority = payload.priority === 'critical' ? 1 : payload.priority === 'high' ? 2 : payload.priority === 'medium' ? 5 : 10;
  await notificationQueue.add(payload.type, payload, { priority });
  logger.debug('Notification enqueued', { type: payload.type, userId: payload.userId });
}

// ── Quiet hours check ─────────────────────────────────────────────────────────
function isInQuietHours(pref: UserNotificationPreference): boolean {
  if (!pref.quiet_hours_enabled) return false;
  const now   = new Date();
  const hhmm  = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  const start = pref.quiet_hours_start;
  const end   = pref.quiet_hours_end;
  if (start > end) {
    // Crosses midnight e.g. 22:00–07:00
    return hhmm >= start || hhmm < end;
  }
  return hhmm >= start && hhmm < end;
}

// ── Process a single notification job ────────────────────────────────────────
async function processJob(job: Job<NotificationJobPayload>): Promise<void> {
  const { userId, appointmentId, type, channels, priority, data } = job.data;

  const pref = await UserNotificationPreference.findOne({ where: { user_id: userId } });

  const rendered = renderNotification(type, data);
  if (!rendered) { logger.warn('Unknown notification type', { type }); return; }

  // Quiet hours check — bypass for critical types
  const bypassQuietHours = BYPASS_QUIET_HOURS[type] ?? false;
  if (pref && priority !== 'critical' && !bypassQuietHours && isInQuietHours(pref)) {
    logger.debug('Notification delayed — quiet hours', { userId, type });
    await job.moveToDelayed(Date.now() + 30 * 60_000);
    return;
  }

  for (const channel of channels) {
    // Check user channel preference
    if (pref) {
      if (channel === NotificationChannel.SMS   && !pref.sms_enabled)   continue;
      if (channel === NotificationChannel.PUSH  && !pref.push_enabled)  continue;
      if (channel === NotificationChannel.EMAIL && !pref.email_enabled) continue;
    }

    // Determine recipient
    const recipient = channel === NotificationChannel.SMS   ? String(data.mobile ?? '')
                    : channel === NotificationChannel.PUSH  ? (pref?.fcm_token ?? String(data.device_token ?? ''))
                    : String(data.email ?? '');

    if (!recipient) continue;

    // Each channel uses its own body format
    const renderedBody = channel === NotificationChannel.SMS  ? rendered.sms
                       : channel === NotificationChannel.PUSH ? rendered.sms   // push body = SMS text (concise)
                       : rendered.htmlBody;

    const logEntry = await NotificationLog.create({
      user_id:           userId,
      appointment_id:    appointmentId ?? null,
      notification_type: type,
      channel,
      recipient,
      rendered_body:     renderedBody,
      provider:          channel === NotificationChannel.SMS ? 'sns' : channel === NotificationChannel.PUSH ? 'fcm' : 'ses',
      provider_msg_id:   null,
      status:            NotificationStatus.QUEUED,
      attempt_count:     job.attemptsMade + 1,
      last_attempt_at:   new Date(),
      delivered_at:      null,
      failure_reason:    null,
    });

    try {
      const sendResult = await sendViaProvider(channel, recipient, renderedBody, rendered.subject);
      await logEntry.update({ status: NotificationStatus.SENT, provider_msg_id: sendResult.msgId, provider: sendResult.provider });
      logger.info('Notification sent', { type, channel, userId });
    } catch (err) {
      await logEntry.update({ status: NotificationStatus.FAILED, failure_reason: String(err) });
      throw err;  // BullMQ will retry
    }
  }
}

// ── Provider dispatch ─────────────────────────────────────────────────────────
async function sendViaProvider(
  channel:   NotificationChannel,
  recipient: string,
  body:      string,
  subject:   string,
): Promise<{ msgId: string; provider: string }> {
  if (channel === NotificationChannel.SMS) {
    const result = await sendSMS(recipient, body);
    return result;
  }
  if (channel === NotificationChannel.PUSH) {
    const result = await sendPush(recipient, 'Upcharify', body);
    return { msgId: result.msgId, provider: 'fcm' };
  }
  // Email via AWS SES — body is rendered HTML; strip tags for plain-text part
  const plainText = body.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const result = await sendEmail(recipient, subject, plainText, body);
  return { msgId: result.msgId, provider: 'ses' };
}

// ── Start worker ──────────────────────────────────────────────────────────────
export function startNotificationWorker(): Worker {
  const worker = new Worker('notifications', processJob, {
    connection: queueConnection,
    concurrency: 10,
  });

  worker.on('completed', (job) => logger.debug('Notification job done', { id: job.id }));
  worker.on('failed',    (job, err) => logger.error('Notification job failed', { id: job?.id, err }));

  logger.info('📬  Notification worker started');
  return worker;
}

// ── Register / update FCM device token ───────────────────────────────────────
export async function registerDeviceToken(
  userId: string,
  fcmToken: string,
): Promise<ServiceResponse<object>> {
  const [pref] = await UserNotificationPreference.findOrCreate({
    where:    { user_id: userId },
    defaults: { user_id: userId, fcm_token: fcmToken },
  });
  if (pref.fcm_token !== fcmToken) {
    await pref.update({ fcm_token: fcmToken });
  }
  return ok({ message: 'Device token registered.' });
}

// ── Update notification preferences ──────────────────────────────────────────
export async function updatePreferences(
  userId: string,
  updates: Partial<UserNotificationPreference>,
): Promise<ServiceResponse<object>> {
  const [pref, created] = await UserNotificationPreference.findOrCreate({
    where:    { user_id: userId },
    defaults: { user_id: userId, ...updates },
  });

  if (!created) await pref.update(updates);
  return ok({ message: 'Preferences updated.', preferences: pref });
}

// ── Get notification preferences ─────────────────────────────────────────────
export async function getPreferences(userId: string): Promise<ServiceResponse<object>> {
  const [pref] = await UserNotificationPreference.findOrCreate({
    where:    { user_id: userId },
    defaults: { user_id: userId },
  });
  return ok(pref);
}

// ── Get notification history ──────────────────────────────────────────────────
export async function getNotificationHistory(
  userId:  string,
  page:    number,
  perPage: number,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await NotificationLog.findAndCountAll({
    where: { user_id: userId },
    order: [['created_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}
