import Redlock, { ResourceLockedError } from 'redlock';
import { redis } from './redis';
import { logger } from '../utils/logger';

// Single-instance Redlock — uses the same ioredis client already connected.
// For multi-node Redis (cluster/sentinel), pass multiple clients to the constructor.
export const redlock = new Redlock([redis as any], {
  driftFactor:   0.01,  // clock drift compensation
  retryCount:    3,
  retryDelay:    200,   // ms between retries
  retryJitter:   100,   // random jitter to avoid thundering herd
  automaticExtensionThreshold: 500, // auto-extend if lock holder takes longer than expected
});

redlock.on('error', (err: unknown) => {
  if (err instanceof ResourceLockedError) return;
  logger.error('Redlock error', { err });
});

/**
 * Convenience wrapper — acquires a lock, runs fn, then releases.
 * If the lock cannot be acquired within retryCount attempts, throws ResourceLockedError.
 */
export async function withLock<T>(
  resource: string,
  ttlMs:    number,
  fn:       () => Promise<T>,
): Promise<T> {
  const lock = await redlock.acquire([resource], ttlMs);
  try {
    return await fn();
  } finally {
    await lock.release().catch((err: unknown) => {
      logger.warn('Failed to release Redlock — TTL will expire naturally', { resource, err });
    });
  }
}
