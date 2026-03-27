import * as admin  from 'firebase-admin';
import * as fs      from 'fs';
import * as path    from 'path';
import { SNSClient, PublishCommand }         from '@aws-sdk/client-sns';
import { SESClient, SendEmailCommand }       from '@aws-sdk/client-ses';
import { env }    from '../config/env';
import { redis }   from '../config/redis';
import { logger }  from './logger';

// ── AWS clients (lazy, singleton) ─────────────────────────────────────────────

let snsClient: SNSClient | null = null;
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

function getSnsClient(): SNSClient {
  if (!snsClient) snsClient = new SNSClient(getAwsCredentials());
  return snsClient;
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

// ── AWS SNS — SMS ─────────────────────────────────────────────────────────────

async function sendViaSNS(mobile: string, message: string): Promise<string> {
  const sns = getSnsClient();
  const res = await sns.send(new PublishCommand({
    PhoneNumber: `+91${mobile}`,
    Message:     message,
    MessageAttributes: {
      'AWS.SNS.SMS.SenderID': {
        DataType:    'String',
        StringValue: env.AWS_SNS_SENDER_ID,   // set AWS_SNS_SENDER_ID=UPCHARY (DLT registered)
      },
      'AWS.SNS.SMS.SMSType': {
        DataType:    'String',
        StringValue: 'Transactional',   // ensures delivery even during DND
      },
    },
  }));
  if (!res.MessageId) throw new Error('SNS returned no MessageId');
  return res.MessageId;
}

// ── MSG91 ─────────────────────────────────────────────────────────────────────

async function sendViaMSG91(mobile: string, message: string): Promise<string> {
  if (!env.MSG91_AUTH_KEY) throw new Error('MSG91_AUTH_KEY not configured');
  const res = await fetchWithTimeout('https://api.msg91.com/api/v5/otp', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      template_id: env.MSG91_TEMPLATE_ID,
      mobile:      `91${mobile}`,
      authkey:     env.MSG91_AUTH_KEY,
      message,
    }),
  }, 3000);
  if (!res.ok) throw new Error(`MSG91 HTTP ${res.status}`);
  const data = await res.json() as { type: string; request_id?: string };
  if (data.type !== 'success') throw new Error(`MSG91: ${JSON.stringify(data)}`);
  return data.request_id ?? `msg91_${Date.now()}`;
}

// ── Twilio ────────────────────────────────────────────────────────────────────

async function sendViaTwilio(mobile: string, message: string): Promise<string> {
  const sid  = process.env.TWILIO_ACCOUNT_SID;
  const auth = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;
  if (!sid || !auth || !from) throw new Error('Twilio credentials not configured');
  const res = await fetchWithTimeout(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        Authorization:  `Basic ${Buffer.from(`${sid}:${auth}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: `+91${mobile}`, From: from, Body: message }).toString(),
    },
    4000,
  );
  if (!res.ok) throw new Error(`Twilio HTTP ${res.status}`);
  const data = await res.json() as { sid?: string };
  if (!data.sid) throw new Error(`Twilio no SID: ${JSON.stringify(data)}`);
  return data.sid;
}

// ── sendSMS — SNS primary, MSG91 + Twilio fallback ────────────────────────────

export async function sendSMS(mobile: string, message: string): Promise<{ provider: string; msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📱  [SMS → ${mobile}]: ${message}`);
    return { provider: 'console', msgId: `dev_${Date.now()}` };
  }

  // 1. AWS SNS
  if (env.AWS_ACCESS_KEY_ID && !(await isCircuitOpen('sns'))) {
    try {
      const msgId = await sendViaSNS(mobile, message);
      await recordSuccess('sns');
      return { provider: 'sns', msgId };
    } catch (err) {
      await recordFailure('sns');
      logger.warn('SNS SMS failed, trying MSG91', { error: String(err) });
    }
  }

  // 2. MSG91
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

  // 3. Twilio
  if (!(await isCircuitOpen('twilio'))) {
    try {
      const msgId = await sendViaTwilio(mobile, message);
      await recordSuccess('twilio');
      return { provider: 'twilio', msgId };
    } catch (err) {
      await recordFailure('twilio');
      logger.error('All SMS providers failed', { error: String(err) });
    }
  }

  throw new Error('All SMS providers unavailable');
}

// ── AWS SES — Email ───────────────────────────────────────────────────────────

export async function sendEmail(
  to:       string,
  subject:  string,
  textBody: string,
  htmlBody?: string,
): Promise<{ msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📧  [EMAIL → ${to}] ${subject}\n${textBody}`);
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

export async function sendPush(deviceToken: string, title: string, body: string): Promise<{ msgId: string }> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📲  [PUSH → ${deviceToken.slice(0, 20)}...]: ${title} — ${body}`);
    return { msgId: `push_dev_${Date.now()}` };
  }

  const app = getFirebaseApp();
  const msgId = await app.messaging().send({
    token:        deviceToken,
    notification: { title, body },
    android: { priority: 'high', notification: { sound: 'default', channelId: 'upcharify_default' } },
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
