import Redis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

const redisConfig = {
  host: env.REDIS_HOST,
  port: env.REDIS_PORT,
  password: env.REDIS_PASSWORD,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
  retryStrategy: (times: number): number | null => {
    if (times > 10) { logger.error('Redis: max reconnection attempts reached'); return null; }
    return Math.min(times * 200, 3000);
  },
};

export const redis = new Redis(redisConfig);

redis.on('connect', () => logger.info('✅  Redis connected'));
redis.on('error',   (err) => logger.error('Redis error', { error: err.message }));
redis.on('close',   () => logger.warn('Redis connection closed'));

export async function connectRedis(): Promise<void> {
  await redis.connect();
}

// ── Redis key factory ─────────────────────────────────────────────────────────
export const RedisKeys = {
  // Phase 1 — Auth
  otpCooldown:  (mobile: string) => `otp:cooldown:${mobile}`,
  otpLockout:   (mobile: string) => `otp:lockout:${mobile}`,
  otpAttempts:  (mobile: string) => `otp:attempts:${mobile}`,
  jwtBlacklist: (jti: string)    => `blacklist:jti:${jti}`,
  refreshToken: (userId: string) => `refresh:${userId}`,

  // Phase 2 — Booking
  slotLock:        (doctorId: string, slotDatetime: string) => `lock:slot:${doctorId}:${slotDatetime}`,
  availableSlots:  (doctorId: string, date: string)         => `slots:available:${doctorId}:${date}`,
  doctorSchedule:  (doctorId: string)                       => `schedule:doctor:${doctorId}`,
  hospitalDoctors: (hospitalId: string)                     => `hospital:doctors:${hospitalId}`,
} as const;

// ── TTL constants (seconds) ───────────────────────────────────────────────────
export const RedisTTL = {
  // Phase 1
  OTP_COOLDOWN:  env.OTP_COOLDOWN_SECONDS,
  OTP_LOCKOUT:   env.OTP_LOCKOUT_MINUTES * 60,
  OTP_ATTEMPTS:  env.OTP_EXPIRY_MINUTES  * 60,
  REFRESH_TOKEN: 7 * 24 * 60 * 60,

  // Phase 2
  SLOT_LOCK:        5,           // 5 seconds — double-booking distributed lock
  AVAILABLE_SLOTS:  60,          // 1 minute — slot availability cache
  DOCTOR_SCHEDULE:  5 * 60,      // 5 minutes — schedule cache
  HOSPITAL_DOCTORS: 10 * 60,     // 10 minutes — hospital doctor list cache
} as const;
