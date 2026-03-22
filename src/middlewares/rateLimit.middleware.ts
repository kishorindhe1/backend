import rateLimit from 'express-rate-limit';
import { env }   from '../config/env';

// Use Redis store only when Redis is available
async function createStore(prefix: string) {
  if (env.NODE_ENV === 'test') return undefined; // memory store in tests
  try {
    const { RedisStore } = await import('rate-limit-redis');
    const { redis }      = await import('../config/redis');
    return new RedisStore({
      // @ts-expect-error — ioredis is compatible but types differ slightly
      sendCommand: (...args: string[]) => redis.call(...args),
      prefix:      `rl:${prefix}:`,
    });
  } catch {
    return undefined; // fall back to memory store if Redis unavailable
  }
}

function createLimiter(options: {
  windowMs: number;
  max:      number;
  keyPrefix:string;
  message?: string;
}) {
  return rateLimit({
    windowMs:       options.windowMs,
    max:            options.max,
    standardHeaders:true,
    legacyHeaders:  false,
    // store is not set here — set lazily below. Without store it uses memory (fine for tests)
    handler: (_req, res) => {
      res.status(429).json({
        success: false,
        error: {
          code:    'RATE_LIMIT_EXCEEDED',
          message: options.message ?? 'Too many requests. Please try again later.',
        },
      });
    },
    skip: () => env.NODE_ENV === 'test',
  });
}

export const globalRateLimiter  = createLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: env.RATE_LIMIT_MAX_REQUESTS, keyPrefix: 'global', message: 'Too many requests. Please try again in 15 minutes.' });
export const authRateLimiter    = createLimiter({ windowMs: 15 * 60 * 1000, max: 5,  keyPrefix: 'auth',    message: 'Too many authentication attempts.' });
export const bookingRateLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 20, keyPrefix: 'booking', message: 'Too many booking attempts.' });
