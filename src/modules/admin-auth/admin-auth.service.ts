import { env }                        from '../../config/env';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import { User, HospitalStaff }        from '../../models';
import { generateOTP, hashOTP, verifyOTP, hashPassword, verifyPassword, addMinutes } from '../../utils/helpers';
import {
  issueTokenPair, storeRefreshToken, blacklistToken, invalidateRefreshToken, TokenPair,
} from '../auth/token.service';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { ErrorFactory } from '../../utils/errors';
import { logger } from '../../utils/logger';

const ADMIN_ROLES: UserRole[] = [UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN, UserRole.RECEPTIONIST];
const TFA_EXPIRY_MINUTES = 10;

export interface AdminLoginResult {
  masked_email: string;
  expires_in: number;
  resend_allowed_in: number;
}

export interface AdminTwoFactorResult {
  tokens: TokenPair;
  user: { id: string; email: string; role: UserRole; account_status: AccountStatus; };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  const visible = local.slice(0, 2);
  const masked  = '*'.repeat(Math.max(local.length - 2, 3));
  return `${visible}${masked}@${domain}`;
}

async function sendTfaOtpEmail(email: string, otp: string): Promise<void> {
  if (env.NODE_ENV === 'development') {
    logger.debug(`📧  Admin 2FA OTP for ${maskEmail(email)}: ${otp}`);
    return;
  }
  // TODO: integrate email provider (SendGrid / SES / SMTP)
  logger.info('Admin 2FA email sent', { email: maskEmail(email) });
}

// ─── service functions ────────────────────────────────────────────────────────

export async function adminLogin(email: string, password: string): Promise<ServiceResponse<AdminLoginResult>> {
  const user = await User.findOne({ where: { email } });

  if (!user || !user.password_hash || !ADMIN_ROLES.includes(user.role)) {
    // Constant-time-ish response to prevent email enumeration
    return fail('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.', 401);
  }

  if (user.account_status === AccountStatus.SUSPENDED || user.deleted_at) {
    return fail('AUTH_ACCOUNT_SUSPENDED', 'Your account has been suspended.', 403);
  }

  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    return fail('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.', 401);
  }

  // Rate-limit 2FA sends
  const cooldownKey = RedisKeys.adminTfaCooldown(email);
  const cooldownTTL = await redis.ttl(cooldownKey);
  if (cooldownTTL > 0) {
    return fail('RATE_LIMIT_EXCEEDED', 'A 2FA code was already sent. Please wait before requesting again.', 429, { retry_after: cooldownTTL });
  }

  const otp       = generateOTP();
  const otpHash   = await hashOTP(otp);
  const expiresAt = addMinutes(new Date(), TFA_EXPIRY_MINUTES);

  await user.update({ otp_secret: otpHash, otp_expires_at: expiresAt, otp_attempts: 0 });
  await redis.setex(cooldownKey, RedisTTL.OTP_COOLDOWN, '1');
  await sendTfaOtpEmail(email, otp);

  logger.info('Admin 2FA OTP sent', { userId: user.id, email: maskEmail(email) });
  return ok({
    masked_email:      maskEmail(email),
    expires_in:        TFA_EXPIRY_MINUTES * 60,
    resend_allowed_in: RedisTTL.OTP_COOLDOWN,
  });
}

export async function verifyAdminTwoFactor(email: string, otp: string): Promise<ServiceResponse<AdminTwoFactorResult>> {
  const user = await User.findOne({ where: { email } });
  if (!user || !ADMIN_ROLES.includes(user.role)) {
    return fail('AUTH_INVALID_CREDENTIALS', 'Invalid session.', 401);
  }

  const lockoutKey = RedisKeys.adminTfaLockout(email);
  if (await redis.exists(lockoutKey)) {
    const ttl = await redis.ttl(lockoutKey);
    return fail('AUTH_ACCOUNT_LOCKED', 'Too many failed attempts. Please wait before trying again.', 423, { retry_after: ttl });
  }

  if (!user.otp_secret || !user.otp_expires_at) {
    return fail('AUTH_OTP_INVALID', 'No 2FA code found. Please sign in again.', 401);
  }

  if (user.otp_expires_at < new Date()) {
    await user.update({ otp_secret: null, otp_expires_at: null });
    return fail('AUTH_OTP_EXPIRED', '2FA code has expired. Please sign in again.', 401);
  }

  if (user.otp_attempts >= env.OTP_MAX_ATTEMPTS) {
    await redis.setex(lockoutKey, RedisTTL.OTP_LOCKOUT, '1');
    await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0 });
    return fail('AUTH_OTP_MAX_ATTEMPTS', 'Too many failed attempts. Account locked for 30 minutes.', 423);
  }

  const isValid = await verifyOTP(otp, user.otp_secret);
  if (!isValid) {
    const newAttempts = user.otp_attempts + 1;
    await user.update({ otp_attempts: newAttempts });
    const remaining = env.OTP_MAX_ATTEMPTS - newAttempts;
    if (remaining <= 0) {
      await redis.setex(lockoutKey, RedisTTL.OTP_LOCKOUT, '1');
      return fail('AUTH_OTP_MAX_ATTEMPTS', 'Too many failed attempts. Account locked for 30 minutes.', 423);
    }
    return fail('AUTH_OTP_INVALID', `Invalid code. ${remaining} attempt(s) remaining.`, 401);
  }

  await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0, last_login_at: new Date() });
  await redis.del(RedisKeys.adminTfaCooldown(email));

  // Resolve hospital_id for hospital_admin / receptionist
  let hospitalId: string | undefined;
  if (user.role === UserRole.HOSPITAL_ADMIN || user.role === UserRole.RECEPTIONIST) {
    const staffRecord = await HospitalStaff.findOne({
      where: { user_id: user.id, is_active: true },
      order: [['created_at', 'DESC']],
    });
    hospitalId = staffRecord?.hospital_id ?? undefined;
  }

  const tokens = issueTokenPair({ userId: user.id, role: user.role, accountStatus: user.account_status, hospitalId });
  await storeRefreshToken(user.id, tokens.refresh_token);

  logger.info('Admin logged in', { userId: user.id, email: maskEmail(email), role: user.role });
  return ok({ tokens, user: { id: user.id, email, role: user.role, account_status: user.account_status } });
}

// ─── admin account setup (for seeding / super admin bootstrap) ─────────────

export async function setAdminPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await User.update({ password_hash: hash }, { where: { id: userId } });
}
