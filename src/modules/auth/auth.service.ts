import { env }                        from '../../config/env';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import { User }                       from '../../models';
import { PatientProfile }             from '../../models';
import { generateOTP, hashOTP, verifyOTP, maskMobile, addMinutes } from '../../utils/helpers';
import {
  issueTokenPair, verifyRefreshToken, blacklistToken,
  storeRefreshToken, invalidateRefreshToken, isRefreshTokenValid, TokenPair,
} from './token.service';
import { UserRole, AccountStatus, ProfileStatus, ServiceResponse, ok, fail } from '../../types';
import { ErrorFactory } from '../../utils/errors';
import { incrementCounter } from '../admin/admin.service';
import { logger }       from '../../utils/logger';
import { sendSMS }      from '../../utils/smsProvider';

export interface RequestOtpResult {
  expires_in: number; resend_allowed_in: number; masked_mobile: string;
}
export interface VerifyOtpResult {
  tokens: TokenPair;
  user: { id: string; mobile: string; role: UserRole; account_status: AccountStatus; profile_status: ProfileStatus; is_new_user: boolean; };
}

export async function requestOtp(mobile: string, countryCode = '+91'): Promise<ServiceResponse<RequestOtpResult>> {
  const cooldownKey = RedisKeys.otpCooldown(mobile);
  const cooldownTTL = await redis.ttl(cooldownKey);
  if (cooldownTTL > 0) return fail('RATE_LIMIT_EXCEEDED', 'OTP already sent. Please wait before requesting again.', 429, { retry_after: cooldownTTL });

  const lockoutKey = RedisKeys.otpLockout(mobile);
  if (await redis.exists(lockoutKey)) {
    const ttl = await redis.ttl(lockoutKey);
    return fail('AUTH_ACCOUNT_LOCKED', 'Too many failed attempts. Please try again later.', 423, { retry_after: ttl });
  }

  const [user] = await User.findOrCreate({
    where: { mobile },
    defaults: { mobile, country_code: countryCode, role: UserRole.PATIENT, account_status: AccountStatus.OTP_VERIFIED, otp_secret: null, otp_expires_at: null, otp_attempts: 0, last_login_at: null, deleted_at: null },
  });

  const otp       = generateOTP();
  const otpHash   = await hashOTP(otp);
  const expiresAt = addMinutes(new Date(), env.OTP_EXPIRY_MINUTES);

  await user.update({ otp_secret: otpHash, otp_expires_at: expiresAt, otp_attempts: 0 });
  await redis.setex(cooldownKey, RedisTTL.OTP_COOLDOWN, '1');
  await sendOtpSms(mobile, otp);

  logger.info('OTP requested', { mobile: maskMobile(mobile) });
  return ok({
    expires_in:       env.OTP_EXPIRY_MINUTES * 60,
    resend_allowed_in:RedisTTL.OTP_COOLDOWN,
    masked_mobile:    maskMobile(mobile),
    ...(env.OTP_BYPASS_CODE ? { dev_otp: otp } : {}),
  });
}

export async function verifyOtp(mobile: string, otp: string): Promise<ServiceResponse<VerifyOtpResult>> {
  const user = await User.findOne({ where: { mobile } });
  if (!user) return fail('AUTH_OTP_INVALID', 'Invalid OTP.', 401);

  const lockoutKey = RedisKeys.otpLockout(mobile);
  if (await redis.exists(lockoutKey)) {
    const ttl = await redis.ttl(lockoutKey);
    return fail('AUTH_ACCOUNT_LOCKED', 'Too many failed attempts.', 423, { retry_after: ttl });
  }

  if (user.otp_attempts >= env.OTP_MAX_ATTEMPTS) {
    await redis.setex(lockoutKey, RedisTTL.OTP_LOCKOUT, '1');
    await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0 });
    return fail('AUTH_OTP_MAX_ATTEMPTS', 'Too many failed attempts. Account locked for 30 minutes.', 423);
  }

  if (!user.otp_secret || !user.otp_expires_at) return fail('AUTH_OTP_INVALID', 'No OTP found. Please request a new one.', 401);
  if (user.otp_expires_at < new Date()) { await user.update({ otp_secret: null, otp_expires_at: null }); return fail('AUTH_OTP_EXPIRED', 'OTP has expired.', 401); }

  const isBypass = env.OTP_BYPASS_CODE && otp === env.OTP_BYPASS_CODE;
  const isValid  = isBypass || await verifyOTP(otp, user.otp_secret);
  if (!isValid) {
    const newAttempts = user.otp_attempts + 1;
    await user.update({ otp_attempts: newAttempts });
    const remaining = env.OTP_MAX_ATTEMPTS - newAttempts;
    if (remaining <= 0) { await redis.setex(lockoutKey, RedisTTL.OTP_LOCKOUT, '1'); return fail('AUTH_OTP_MAX_ATTEMPTS', 'Too many failed attempts. Account locked for 30 minutes.', 423); }
    return fail('AUTH_OTP_INVALID', `Invalid OTP. ${remaining} attempt(s) remaining.`, 401);
  }

  const isNewUser = user.account_status === AccountStatus.OTP_VERIFIED && !user.last_login_at;
  await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0, account_status: AccountStatus.ACTIVE, last_login_at: new Date() });

  const [profile] = await PatientProfile.findOrCreate({
    where: { user_id: user.id },
    defaults: { user_id: user.id, full_name: null, email: null, date_of_birth: null, gender: null, blood_group: null, profile_photo_url: null, profile_status: ProfileStatus.INCOMPLETE, completed_at: null },
  });

  await Promise.all([redis.del(RedisKeys.otpCooldown(mobile)), redis.del(RedisKeys.otpAttempts(mobile))]);

  const tokens = issueTokenPair({ userId: user.id, role: user.role, accountStatus: AccountStatus.ACTIVE, profileStatus: profile.profile_status });
  await storeRefreshToken(user.id, tokens.refresh_token);

  if (isNewUser) await incrementCounter('registrations');
  logger.info('OTP verified', { userId: user.id, mobile: maskMobile(mobile), isNewUser });
  return ok({ tokens, user: { id: user.id, mobile: maskMobile(mobile), role: user.role, account_status: AccountStatus.ACTIVE, profile_status: profile.profile_status, is_new_user: isNewUser } });
}

export async function refreshAccessToken(refreshToken: string): Promise<ServiceResponse<TokenPair>> {
  const payload = verifyRefreshToken(refreshToken);
  if (!payload) return fail('AUTH_TOKEN_INVALID', 'Invalid or expired refresh token.', 401);

  const isValid = await isRefreshTokenValid(payload.sub, payload.jti);
  if (!isValid) return fail('AUTH_TOKEN_INVALID', 'Refresh token has been revoked.', 401);

  const user = await User.findByPk(payload.sub, { include: [{ model: PatientProfile, as: 'patientProfile' }] });
  if (!user || user.account_status === AccountStatus.SUSPENDED) return fail('AUTH_ACCOUNT_SUSPENDED', 'Account is suspended.', 403);

  const profile = user.patientProfile as PatientProfile | undefined;
  const tokens  = issueTokenPair({ userId: user.id, role: user.role, accountStatus: user.account_status, profileStatus: profile?.profile_status });
  await storeRefreshToken(user.id, tokens.refresh_token);
  return ok(tokens);
}

export async function logout(jti: string, exp: number, userId: string): Promise<ServiceResponse<{ message: string }>> {
  await Promise.all([blacklistToken(jti, exp), invalidateRefreshToken(userId)]);
  logger.info('User logged out', { userId });
  return ok({ message: 'Logged out successfully.' });
}

async function sendOtpSms(mobile: string, otp: string): Promise<void> {
  // MSG91 OTP API substitutes ##OTP## in the DLT-registered template automatically
  const result = await sendSMS(mobile, otp);
  logger.info('OTP SMS sent', { mobile: maskMobile(mobile), provider: result.provider });
}
