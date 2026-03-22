import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../../config/env';
import { redis, RedisKeys } from '../../config/redis';
import { JwtAccessPayload, JwtRefreshPayload, UserRole, AccountStatus, ProfileStatus } from '../../types';
import { logger } from '../../utils/logger';

// ── Issue tokens ──────────────────────────────────────────────────────────────
export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;   // access token TTL in seconds
}

interface IssueTokenParams {
  userId: string;
  role: UserRole;
  accountStatus: AccountStatus;
  profileStatus?: ProfileStatus;
  hospitalId?: string;
}

export function issueTokenPair(params: IssueTokenParams): TokenPair {
  const { userId, role, accountStatus, profileStatus, hospitalId } = params;

  const accessJti  = uuidv4();
  const refreshJti = uuidv4();

  const accessPayload: Omit<JwtAccessPayload, 'iat' | 'exp'> = {
    sub: userId,
    jti: accessJti,
    role,
    account_status: accountStatus,
    ...(profileStatus  && { profile_status: profileStatus }),
    ...(hospitalId     && { hospital_id: hospitalId }),
  };

  const refreshPayload: Omit<JwtRefreshPayload, 'iat' | 'exp'> = {
    sub: userId,
    jti: refreshJti,
    type: 'refresh',
  };

  const access_token = jwt.sign(
    accessPayload,
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.JWT_ACCESS_EXPIRES_IN } as jwt.SignOptions,
  );

  const refresh_token = jwt.sign(
    refreshPayload,
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_EXPIRES_IN } as jwt.SignOptions,
  );

  // Access token TTL in seconds (parse "15m" → 900, "1h" → 3600)
  const expiresIn = parseExpiry(env.JWT_ACCESS_EXPIRES_IN);

  return { access_token, refresh_token, expires_in: expiresIn };
}

// ── Verify access token ───────────────────────────────────────────────────────
export async function verifyAccessToken(token: string): Promise<JwtAccessPayload | null> {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as JwtAccessPayload;

    // Check if jti is blacklisted (logged out)
    const blacklisted = await redis.get(RedisKeys.jwtBlacklist(payload.jti));
    if (blacklisted) return null;

    return payload;
  } catch {
    return null;
  }
}

// ── Verify refresh token ──────────────────────────────────────────────────────
export function verifyRefreshToken(token: string): JwtRefreshPayload | null {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as JwtRefreshPayload;
  } catch {
    return null;
  }
}

// ── Blacklist access token (logout) ──────────────────────────────────────────
export async function blacklistToken(jti: string, expiresAt: number): Promise<void> {
  const ttl = expiresAt - Math.floor(Date.now() / 1000);
  if (ttl <= 0) return; // already expired — no need to blacklist

  try {
    await redis.setex(RedisKeys.jwtBlacklist(jti), ttl, '1');
  } catch (err) {
    logger.error('Failed to blacklist token', { jti, error: err });
    throw err;
  }
}

// ── Store refresh token in Redis (for invalidation on logout) ────────────────
export async function storeRefreshToken(userId: string, jti: string): Promise<void> {
  // Store jti so we can invalidate all refresh tokens on logout
  const key = RedisKeys.refreshToken(userId);
  await redis.setex(key, 7 * 24 * 60 * 60, jti); // 7 days
}

export async function invalidateRefreshToken(userId: string): Promise<void> {
  await redis.del(RedisKeys.refreshToken(userId));
}

export async function isRefreshTokenValid(userId: string, jti: string): Promise<boolean> {
  const stored = await redis.get(RedisKeys.refreshToken(userId));
  return stored === jti;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseExpiry(expiry: string): number {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 900;
  const value = parseInt(match[1], 10);
  const unit  = match[2];
  const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
  return value * (multipliers[unit] ?? 1);
}
