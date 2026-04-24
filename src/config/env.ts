import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT:     z.string().default('3000').transform(Number),

  // Database
  DB_HOST:     z.string().default('localhost'),
  DB_PORT:     z.string().default('5432').transform(Number),
  DB_NAME:     z.string(),
  DB_USER:     z.string(),
  DB_PASSWORD: z.string(),
  DB_POOL_MAX: z.string().default('10').transform(Number),
  DB_POOL_MIN: z.string().default('2').transform(Number),

  // Redis
  REDIS_HOST:     z.string().default('localhost'),
  REDIS_PORT:     z.string().default('6379').transform(Number),
  REDIS_PASSWORD: z.string().optional(),

  // JWT
  JWT_ACCESS_SECRET:      z.string().min(32),
  JWT_REFRESH_SECRET:     z.string().min(32),
  JWT_ACCESS_EXPIRES_IN:  z.string().default('15m'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // OTP
  OTP_EXPIRY_MINUTES:  z.string().default('10').transform(Number),
  OTP_MAX_ATTEMPTS:    z.string().default('5').transform(Number),
  OTP_COOLDOWN_SECONDS:z.string().default('60').transform(Number),
  OTP_LOCKOUT_MINUTES: z.string().default('30').transform(Number),
  OTP_BYPASS_CODE:     z.string().optional(), // dev only — set to bypass SMS

  // SMS
  MSG91_AUTH_KEY:    z.string().optional(),
  MSG91_SENDER_ID:   z.string().default('HLTHBK'),
  MSG91_TEMPLATE_ID: z.string().optional(),

  // Security
  BCRYPT_ROUNDS: z.string().default('12').transform(Number),

  // Rate limiting
  RATE_LIMIT_WINDOW_MS:   z.string().default('900000').transform(Number),
  RATE_LIMIT_MAX_REQUESTS:z.string().default('100').transform(Number),

  // ── Phase 2 ──────────────────────────────────────────────────────────────
  // Razorpay
  RAZORPAY_KEY_ID:        z.string().optional(),
  RAZORPAY_KEY_SECRET:    z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET:z.string().optional(),

  // Platform fee
  PLATFORM_FEE_PERCENTAGE:   z.string().default('2').transform(Number),

  // Cancellation policy: minimum hours before appointment for refund eligibility
  REFUND_WINDOW_HOURS: z.string().default('2').transform(Number),

  // Slot generation
  SLOT_GENERATION_DAYS_AHEAD: z.string().default('30').transform(Number),

  // Firebase (FCM push notifications) — set ONE of these:
  FIREBASE_SERVICE_ACCOUNT_PATH: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_JSON: z.string().optional(),

  // AWS
  AWS_REGION:            z.string().default('ap-south-1'),
  AWS_ACCESS_KEY_ID:     z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // AWS SES
  AWS_SES_FROM_EMAIL:    z.string().optional(),  // must be a verified identity in SES
  AWS_SES_FROM_NAME:     z.string().default('Upcharify'),

  // AWS SNS SMS
  AWS_SNS_SENDER_ID:     z.string().default('UPCHARY'),   // registered DLT sender ID (max 11 chars)

  // GST / Invoice
  COMPANY_GSTIN:         z.string().optional(),  // e.g. 27AABCU9603R1ZX
  COMPANY_ADDRESS:       z.string().optional(),  // shown on invoice footer

  // Teleconsult
  TELECONSULT_BASE_URL:  z.string().default('https://consult.upcharify.com'),

  // Admin panel URL (used in invite emails)
  ADMIN_PANEL_URL: z.string().default('https://admin.upcharify.com'),

  // Cloudinary — image uploads (doctor photos, hospital logos, patient photos)
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY:    z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌  Invalid environment variables:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env  = typeof env;
// appended above — env.ts already has all required fields
