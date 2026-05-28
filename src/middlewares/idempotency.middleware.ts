import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis';
import { logger } from '../utils/logger';

const TTL_SECONDS = 86_400; // 24 hours — idempotency window

interface CachedResponse {
  status:  number;
  body:    unknown;
}

/**
 * Idempotency middleware — attach to any mutating endpoint (POST booking, POST payment).
 *
 * Client sends:  X-Idempotency-Key: <uuid>
 * First call:    executes normally, caches the response in Redis.
 * Repeat calls:  returns cached response immediately with X-Idempotent-Replayed: true.
 *
 * Key is scoped to the authenticated user (sub from JWT) to prevent key-squatting
 * across different users.
 */
export function idempotency(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-idempotency-key'] as string | undefined;
  if (!key) { next(); return; }

  // Require the key to look like a UUID to prevent trivially short keys
  if (!/^[0-9a-f-]{16,128}$/i.test(key)) {
    res.status(400).json({
      success: false,
      error: { code: 'INVALID_IDEMPOTENCY_KEY', message: 'X-Idempotency-Key must be a UUID.' },
    });
    return;
  }

  const userId   = (req as any).user?.sub ?? 'anon';
  const redisKey = `idempotency:${userId}:${key}`;

  redis.get(redisKey).then((cached) => {
    if (cached) {
      const { status, body } = JSON.parse(cached) as CachedResponse;
      res.setHeader('X-Idempotent-Replayed', 'true');
      res.status(status).json(body);
      return;
    }

    // Intercept res.json to cache the response before sending
    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      const payload: CachedResponse = { status: res.statusCode, body };
      // Only cache success responses (2xx) — don't cache validation errors
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis.set(redisKey, JSON.stringify(payload), 'EX', TTL_SECONDS).catch((err) => {
          logger.warn('Failed to cache idempotency response', { key: redisKey, err });
        });
      }
      return originalJson(body);
    };

    next();
  }).catch((err) => {
    logger.warn('Idempotency Redis lookup failed, proceeding without cache', { err });
    next();
  });
}
