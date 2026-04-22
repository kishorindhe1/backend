import * as admin  from 'firebase-admin';
import * as fs      from 'fs';
import * as path    from 'path';
import { SESClient, SendEmailCommand }       from '@aws-sdk/client-ses';
import { env }    from '../config/env';
import { redis }   from '../config/redis';
import { logger }  from './logger';

// ── AWS SES client (lazy, singleton) ──────────────────────────────────────────

let sesClient: SESClient | null = null;

function getAwsCredentials() {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set');
  }
  return {
    region:      env.AWS_REGION,
    credentials: {
      accessKeyId:     env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  };
}

function getSesClient(): SESClient {
  if (!sesClient) sesClient = new SESClient(getAwsCredentials());
  return sesClient;
}

// ── Firebase Admin (lazy, singleton) ──────────────────────────────────────────

let firebaseApp: admin.app.App | null = null;

function loadServiceAccount(): admin.ServiceAccount {
  if (env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const resolved = path.resolve(env.FIREBASE_SERVICE_ACCOUNT_PATH);
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'));
  }
  if (env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  throw new Error('Set FIREBASE_SERVICE_ACCOUNT_PATH or FIREBASE_SERVICE_ACCOUNT_JSON in .env');
}

function getFirebaseApp(): admin.app.App {
  if (firebaseApp) return firebaseApp;
  firebaseApp = admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  return firebaseApp;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

const CB_KEY      = (p: string) => `cb:sms:${p}`;
const CB_FAIL_KEY = (p: string) => `cb:sms:fails:${p}`;
const CB_TTL      = 10 * 60;
const FAIL_THRESH = 3;

async function isCircuitOpen(provider: string): Promise<boolean> {
  return !!(await redis.get(CB_KEY(provider)));
}

async function recordFailure(provider: string): Promise<void> {
  const key   = CB_FAIL_KEY(provider);
  const fails = await redis.incr(key);
  await redis.expire(key, 300);
  if (fails >= FAIL_THRESH) {
    await redis.setex(CB_KEY(provider), CB_TTL, '1');
    logger.warn(`Circuit breaker OPEN for ${provider}`);
  }
}

async function recordSuccess(provider: string): Promise<void> {
  await redis.del(CB_FAIL_KEY(provider));
  await redis.del(CB_KEY(provider));
}

// ── MSG91 ─────────────────────────────────────────────────────────────────────

async function sendViaMSG91(mobile: string, otp: string): Promise<string> {
  if (!env.MSG91_AUTH_KEY)     throw new Error('MSG91_AUTH_KEY not configured');
  if (!env.MSG91_TEMPLATE_ID)  throw new Error('MSG91_TEMPLATE_ID not configured');

  const payload = {
    template_id: env.MSG91_TEMPLATE_ID,
    sender:      env.MSG91_SENDER_ID,
    mobiles:     `91${mobile}`,
    OTP:         otp,             // matches ##OTP## variable in the DLT template
  };
  logger.debug('MSG91 request', { mobile: `91${mobile}`, template_id: env.MSG91_TEMPLATE_ID });

  const res = await fetchWithTimeout('https://control.msg91.com/api/v5/flow/', {
    method:  'POST',
    headers: {
      'Content-Type': 'application/JSON',
      'authkey':      env.MSG91_AUTH_KEY,
    },
    body: JSON.stringify(payload),
  }, 3000);

  const data = await res.json() as { type?: string; message?: string; request_id?: string };
  logger.debug('MSG91 response', { status: res.status, data });

  if (!res.ok || (data.type && data.type !== 'success')) {
    throw new Error(`MSG91: ${JSON.stringify(data)}`);
  }
  return data.request_id ?? data.message ?? `msg91_${Date.now()}`;
}

// ── sendSMS — MSG91 only (OTP permission only) ────────────────────────────────

export async function sendSMS(mobile: string, otp: string): Promise<{ provider: string; msgId: string }> {
  if (await isCircuitOpen('msg91')) {
    throw new Error('MSG91 circuit breaker is open');
  }

  try {
    const msgId = await sendViaMSG91(mobile, otp);
    await recordSuccess('msg91');
    return { provider: 'msg91', msgId };
  } catch (err) {
    await recordFailure('msg91');
    logger.error('MSG91 OTP SMS failed', { error: String(err) });
    throw err;
  }
}

// ── AWS SES — Email ───────────────────────────────────────────────────────────

export async function sendEmail(
  to:       string,
  subject:  string,
  textBody: string,
  htmlBody?: string,
): Promise<{ msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📧  [EMAIL → ${to}] ${subject} (body omitted)`);
    return { msgId: `email_dev_${Date.now()}` };
  }

  if (!env.AWS_SES_FROM_EMAIL) throw new Error('AWS_SES_FROM_EMAIL not configured');

  const ses = getSesClient();
  const res = await ses.send(new SendEmailCommand({
    Source:      `${env.AWS_SES_FROM_NAME} <${env.AWS_SES_FROM_EMAIL}>`,
    Destination: { ToAddresses: [to] },
    Message: {
      Subject: { Data: subject, Charset: 'UTF-8' },
      Body: {
        Text: { Data: textBody, Charset: 'UTF-8' },
        ...(htmlBody ? { Html: { Data: htmlBody, Charset: 'UTF-8' } } : {}),
      },
    },
  }));

  const msgId = res.MessageId ?? `ses_${Date.now()}`;
  logger.info('SES email sent', { to, subject, msgId });
  return { msgId };
}

// ── FCM Push ──────────────────────────────────────────────────────────────────

export async function sendPush(
  deviceToken: string,
  title:       string,
  body:        string,
  data?:       Record<string, string>,
): Promise<{ msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📲  [PUSH → ${deviceToken.slice(0, 20)}...]: ${title} — ${body}`, { data });
    return { msgId: `push_dev_${Date.now()}` };
  }

  const app = getFirebaseApp();
  const msgId = await app.messaging().send({
    token:        deviceToken,
    notification: { title, body },
    data:         data ?? {},
    android: { priority: 'high', notification: { sound: 'default', channelId: 'upcharify_alerts' } },
    apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
  });
  logger.info('FCM push sent', { msgId, token: deviceToken.slice(0, 20) });
  return { msgId };
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, options: RequestInit, ms: number): Promise<Response> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}
