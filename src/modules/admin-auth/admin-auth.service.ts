import { env }                        from '../../config/env';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import { User, HospitalStaff, DoctorHospitalAffiliation } from '../../models';
import { generateOTP, hashOTP, verifyOTP, hashPassword, verifyPassword, addMinutes } from '../../utils/helpers';
import {
  issueTokenPair, storeRefreshToken, blacklistToken, invalidateRefreshToken, TokenPair,
} from '../auth/token.service';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { ErrorFactory } from '../../utils/errors';
import { logger } from '../../utils/logger';
import { sendEmail } from '../../utils/smsProvider';

const ADMIN_ROLES: UserRole[] = [UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN, UserRole.RECEPTIONIST, UserRole.DOCTOR];
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
  const subject  = 'Your Admin Login OTP';
  const textBody = `Your Upcharify admin login OTP is: ${otp}\n\nThis code expires in ${TFA_EXPIRY_MINUTES} minutes. Do not share it with anyone.`;
  const htmlBody = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#6366f1;margin-bottom:8px">Admin Login Verification</h2>
      <p style="color:#475569;margin-bottom:24px">Use the OTP below to complete your sign-in. It expires in <strong>${TFA_EXPIRY_MINUTES} minutes</strong>.</p>
      <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#0f172a">${otp}</span>
      </div>
      <p style="color:#94a3b8;font-size:13px">If you did not request this, please secure your account immediately.</p>
    </div>`;
  await sendEmail(email, subject, textBody, htmlBody);
  logger.info('Admin 2FA OTP email sent', { email: maskEmail(email) });
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

  // Resolve hospital_id for hospital_admin / receptionist / doctor
  let hospitalId: string | undefined;
  if (user.role === UserRole.HOSPITAL_ADMIN || user.role === UserRole.RECEPTIONIST) {
    const staffRecord = await HospitalStaff.findOne({
      where: { user_id: user.id, is_active: true },
      order: [['created_at', 'DESC']],
    });
    hospitalId = staffRecord?.hospital_id ?? undefined;
  } else if (user.role === UserRole.DOCTOR) {
    const affiliation = await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: user.id, is_primary: true, is_active: true },
    }) ?? await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: user.id, is_active: true },
      order: [['created_at', 'ASC']],
    });
    hospitalId = affiliation?.hospital_id ?? undefined;
  }

  const tokens = issueTokenPair({ userId: user.id, role: user.role, accountStatus: user.account_status, hospitalId });
  await storeRefreshToken(user.id, tokens.refresh_token);

  logger.info('Admin logged in', { userId: user.id, email: maskEmail(email), role: user.role });
  return ok({ tokens, user: { id: user.id, email, role: user.role, account_status: user.account_status } });
}

// ─── Accept hospital invite (set password via email invite link) ──────────────

export interface AcceptInviteResult {
  tokens: TokenPair;
  user: { id: string; email: string; role: UserRole; };
}

export async function acceptHospitalInvite(
  email: string,
  token: string,
  password: string,
): Promise<ServiceResponse<AcceptInviteResult>> {
  const user = await User.findOne({ where: { email } });

  if (!user || user.role !== UserRole.HOSPITAL_ADMIN) {
    return fail('INVITE_INVALID', 'Invalid or expired invite link.', 400);
  }

  if (!user.otp_secret || !user.otp_expires_at) {
    return fail('INVITE_INVALID', 'Invite link has already been used or has expired.', 400);
  }

  if (user.otp_expires_at < new Date()) {
    await user.update({ otp_secret: null, otp_expires_at: null });
    return fail('INVITE_EXPIRED', 'Invite link has expired. Please contact your administrator.', 400);
  }

  const isValid = await verifyOTP(token, user.otp_secret);
  if (!isValid) return fail('INVITE_INVALID', 'Invalid or expired invite link.', 400);

  const passwordHash = await hashPassword(password);
  await user.update({
    password_hash:  passwordHash,
    otp_secret:     null,
    otp_expires_at: null,
    otp_attempts:   0,
    account_status: AccountStatus.ACTIVE,
    last_login_at:  new Date(),
  });

  // Resolve hospital_id for the token
  const { HospitalStaff } = await import('../../models');
  const staffRecord = await HospitalStaff.findOne({
    where: { user_id: user.id, is_active: true },
    order: [['created_at', 'DESC']],
  });

  const tokens = issueTokenPair({
    userId: user.id,
    role: user.role,
    accountStatus: AccountStatus.ACTIVE,
    hospitalId: staffRecord?.hospital_id ?? undefined,
  });
  await storeRefreshToken(user.id, tokens.refresh_token);

  logger.info('Hospital admin accepted invite', { userId: user.id, email: maskEmail(email) });
  return ok({ tokens, user: { id: user.id, email, role: user.role } });
}

// ─── Forgot / Reset password ──────────────────────────────────────────────────

const RESET_EXPIRY_MINUTES = 15;

export async function forgotPassword(email: string): Promise<ServiceResponse<{ masked_email: string }>> {
  const user = await User.findOne({ where: { email } });

  // Always respond OK to prevent email enumeration
  if (!user || !ADMIN_ROLES.includes(user.role) || user.account_status === AccountStatus.SUSPENDED) {
    return ok({ masked_email: maskEmail(email) });
  }

  const cooldownKey = `admin:pw-reset:cooldown:${email}`;
  const cooldownTTL = await redis.ttl(cooldownKey);
  if (cooldownTTL > 0) {
    return fail('RATE_LIMIT_EXCEEDED', 'A reset code was already sent. Please wait before requesting again.', 429, { retry_after: cooldownTTL });
  }

  const otp       = generateOTP();
  const otpHash   = await hashOTP(otp);
  const expiresAt = addMinutes(new Date(), RESET_EXPIRY_MINUTES);

  await user.update({ otp_secret: otpHash, otp_expires_at: expiresAt, otp_attempts: 0 });
  await redis.setex(cooldownKey, RedisTTL.OTP_COOLDOWN, '1');

  const htmlBody = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
      <h2 style="color:#6366f1;margin-bottom:8px">Password Reset</h2>
      <p style="color:#475569;margin-bottom:24px">Use the code below to reset your Upcharify admin password. It expires in <strong>${RESET_EXPIRY_MINUTES} minutes</strong>.</p>
      <div style="background:#f1f5f9;border-radius:12px;padding:24px;text-align:center;margin-bottom:24px">
        <span style="font-size:36px;font-weight:900;letter-spacing:8px;color:#0f172a">${otp}</span>
      </div>
      <p style="color:#94a3b8;font-size:13px">If you did not request a password reset, you can safely ignore this email.</p>
    </div>`;

  await sendEmail(email, 'Upcharify Admin — Password Reset Code',
    `Your password reset code is: ${otp}\n\nExpires in ${RESET_EXPIRY_MINUTES} minutes. If you did not request this, ignore this email.`,
    htmlBody,
  );

  logger.info('Admin password reset code sent', { email: maskEmail(email) });
  return ok({ masked_email: maskEmail(email) });
}

export async function resetPassword(email: string, token: string, newPassword: string): Promise<ServiceResponse<{ message: string }>> {
  const user = await User.findOne({ where: { email } });

  if (!user || !ADMIN_ROLES.includes(user.role)) {
    return fail('RESET_INVALID', 'Invalid or expired reset code.', 400);
  }

  if (!user.otp_secret || !user.otp_expires_at) {
    return fail('RESET_INVALID', 'No reset code found. Please request a new one.', 400);
  }

  if (user.otp_expires_at < new Date()) {
    await user.update({ otp_secret: null, otp_expires_at: null });
    return fail('RESET_EXPIRED', 'Reset code has expired. Please request a new one.', 400);
  }

  const isValid = await verifyOTP(token, user.otp_secret);
  if (!isValid) {
    const newAttempts = user.otp_attempts + 1;
    await user.update({ otp_attempts: newAttempts });
    if (newAttempts >= env.OTP_MAX_ATTEMPTS) {
      await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0 });
      return fail('RESET_INVALID', 'Too many failed attempts. Please request a new reset code.', 400);
    }
    return fail('RESET_INVALID', 'Invalid reset code. Please try again.', 400);
  }

  const passwordHash = await hashPassword(newPassword);
  await user.update({ password_hash: passwordHash, otp_secret: null, otp_expires_at: null, otp_attempts: 0 });

  logger.info('Admin password reset', { userId: user.id, email: maskEmail(email) });
  return ok({ message: 'Password reset successfully. You can now sign in with your new password.' });
}

// ─── admin account setup (for seeding / super admin bootstrap) ─────────────

export async function setAdminPassword(userId: string, password: string): Promise<void> {
  const hash = await hashPassword(password);
  await User.update({ password_hash: hash }, { where: { id: userId } });
}
