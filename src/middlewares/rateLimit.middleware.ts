import rateLimit, { RateLimitRequestHandler } from 'express-rate-limit';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// ── Limiter registry — populated by initRateLimiters() at server startup ──────
// Exported as 'let' so the registry mutates in place after init; callers hold
// a reference to the same object and will see the Redis-backed store.
export let globalRateLimiter:  RateLimitRequestHandler;
export let authRateLimiter:    RateLimitRequestHandler;
export let bookingRateLimiter: RateLimitRequestHandler;

function makeHandler(message: string) {
  return (_req: any, res: any) => {
    res.status(429).json({
      success: false,
      error: { code: 'RATE_LIMIT_EXCEEDED', message },
    });
  };
}

async function buildStore(prefix: string) {
  if (env.NODE_ENV === 'test') return undefined;
  try {
    const { RedisStore } = await import('rate-limit-redis');
    const { redis }      = await import('../config/redis');
    return new RedisStore({
      // @ts-expect-error — ioredis is compatible but types differ slightly
      sendCommand: (...args: string[]) => redis.call(...args),
      prefix:      `rl:${prefix}:`,
    });
  } catch (err) {
    logger.warn('Rate-limit Redis store unavailable, falling back to memory', { err });
    return undefined;
  }
}

/**
 * Must be called once during server bootstrap (after connectRedis()).
 * Attaches the Redis store to every limiter so hits are shared across all
 * instances and survive process restarts.
 */
export async function initRateLimiters(): Promise<void> {
  const [globalStore, authStore, bookingStore] = await Promise.all([
    buildStore('global'),
    buildStore('auth'),
    buildStore('booking'),
  ]);

  globalRateLimiter = rateLimit({
    windowMs:        env.RATE_LIMIT_WINDOW_MS,
    max:             env.RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders:   false,
    store:           globalStore,
    skip:            (req) => typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer '),
    handler:         makeHandler('Too many requests. Please try again in 15 minutes.'),
  });

  authRateLimiter = rateLimit({
    windowMs:        15 * 60 * 1000,
    max:             50,
    standardHeaders: true,
    legacyHeaders:   false,
    store:           authStore,
    handler:         makeHandler('Too many authentication attempts.'),
    skip:            () => env.NODE_ENV === 'test',
  });

  bookingRateLimiter = rateLimit({
    windowMs:        60 * 60 * 1000,
    max:             20,
    standardHeaders: true,
    legacyHeaders:   false,
    store:           bookingStore,
    handler:         makeHandler('Too many booking attempts.'),
    skip:            () => env.NODE_ENV === 'test',
  });

  logger.info('Rate limiters initialised', {
    global_store:  globalStore  ? 'redis' : 'memory',
    auth_store:    authStore    ? 'redis' : 'memory',
    booking_store: bookingStore ? 'redis' : 'memory',
  });
}

// Temporary no-op placeholders so the module can be imported before init().
// These are replaced by initRateLimiters() before the first request arrives.
globalRateLimiter  = rateLimit({ windowMs: 1, max: 999999, skip: () => true });
authRateLimiter    = rateLimit({ windowMs: 1, max: 999999, skip: () => true });
bookingRateLimiter = rateLimit({ windowMs: 1, max: 999999, skip: () => true });
