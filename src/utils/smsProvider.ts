import { env }    from '../config/env';
import { redis }   from '../config/redis';
import { logger }  from './logger';

// ── Circuit breaker keys ──────────────────────────────────────────────────────
const CB_KEY      = (provider: string) => `cb:sms:${provider}`;
const CB_FAIL_KEY = (provider: string) => `cb:sms:fails:${provider}`;
const CB_TTL      = 10 * 60;  // open for 10 minutes
const FAIL_THRESH = 3;         // open after 3 consecutive failures

async function isCircuitOpen(provider: string): Promise<boolean> {
  return !!(await redis.get(CB_KEY(provider)));
}

async function recordFailure(provider: string): Promise<void> {
  const key = CB_FAIL_KEY(provider);
  const fails = await redis.incr(key);
  await redis.expire(key, 300);  // reset counter after 5 min
  if (fails >= FAIL_THRESH) {
    await redis.setex(CB_KEY(provider), CB_TTL, '1');
    logger.warn(`SMS circuit breaker OPEN for ${provider}`);
  }
}

async function recordSuccess(provider: string): Promise<void> {
  await redis.del(CB_FAIL_KEY(provider));
  await redis.del(CB_KEY(provider));  // close circuit on success
}

// ── MSG91 ─────────────────────────────────────────────────────────────────────
async function sendViaMSG91(mobile: string, message: string): Promise<string> {
  if (!env.MSG91_AUTH_KEY) throw new Error('MSG91_AUTH_KEY not configured');

  const url  = 'https://api.msg91.com/api/v5/otp';
  const body = JSON.stringify({
    template_id: env.MSG91_TEMPLATE_ID,
    mobile:      `91${mobile}`,
    authkey:     env.MSG91_AUTH_KEY,
    message,
  });

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  }, 3000);

  if (!res.ok) throw new Error(`MSG91 HTTP ${res.status}`);
  const data = await res.json() as { type: string; request_id?: string };
  if (data.type !== 'success') throw new Error(`MSG91 error: ${JSON.stringify(data)}`);
  return data.request_id ?? `msg91_${Date.now()}`;
}

// ── Twilio ────────────────────────────────────────────────────────────────────
async function sendViaTwilio(mobile: string, message: string): Promise<string> {
  const keyId     = process.env.TWILIO_ACCOUNT_SID;
  const keySecret = process.env.TWILIO_AUTH_TOKEN;
  const from      = process.env.TWILIO_PHONE_NUMBER;

  if (!keyId || !keySecret || !from) throw new Error('Twilio credentials not configured');

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${keyId}/Messages.json`;
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const body = new URLSearchParams({ To: `+91${mobile}`, From: from, Body: message });

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  }, 4000);

  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
  const data = await res.json() as { sid?: string; status?: string };
  if (!data.sid) throw new Error(`Twilio no SID: ${JSON.stringify(data)}`);
  return data.sid;
}

// ── Main send function with fallback ─────────────────────────────────────────
export async function sendSMS(mobile: string, message: string): Promise<{ provider: string; msgId: string }> {
  // Development: log to console
  if (env.NODE_ENV === 'development') {
    logger.debug(`📱  [SMS → ${mobile}]: ${message}`);
    return { provider: 'console', msgId: `dev_${Date.now()}` };
  }

  // Try MSG91 first
  if (!(await isCircuitOpen('msg91'))) {
    try {
      const msgId = await sendViaMSG91(mobile, message);
      await recordSuccess('msg91');
      return { provider: 'msg91', msgId };
    } catch (err) {
      await recordFailure('msg91');
      logger.warn('MSG91 failed, trying Twilio', { error: String(err) });
    }
  }

  // Fallback to Twilio
  if (!(await isCircuitOpen('twilio'))) {
    try {
      const msgId = await sendViaTwilio(mobile, message);
      await recordSuccess('twilio');
      return { provider: 'twilio', msgId };
    } catch (err) {
      await recordFailure('twilio');
      logger.error('Twilio also failed', { error: String(err) });
    }
  }

  throw new Error('All SMS providers unavailable');
}

// ── Push notification stub (FCM) ──────────────────────────────────────────────
export async function sendPush(deviceToken: string, title: string, body: string): Promise<{ msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📲  [PUSH → ${deviceToken.slice(0, 20)}...]: ${title} — ${body}`);
    return { msgId: `push_dev_${Date.now()}` };
  }
  // TODO: FCM integration
  // const { GoogleAuth } = require('google-auth-library');
  // const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  logger.info('Push notification stub called', { deviceToken: deviceToken.slice(0, 20) });
  return { msgId: `push_${Date.now()}` };
}

// ── Fetch with timeout helper ─────────────────────────────────────────────────
async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
