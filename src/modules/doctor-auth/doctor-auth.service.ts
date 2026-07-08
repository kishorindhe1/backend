import crypto from 'crypto';
import { Op } from 'sequelize';
import { env } from '../../config/env';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import {
  DoctorHospitalAffiliation,
  DoctorInviteStatus,
  DoctorProfile,
  User,
} from '../../models';
import { AccountStatus, ServiceResponse, UserRole, fail, ok } from '../../types';
import { addMinutes, generateOTP, hashOTP, hashPassword, maskMobile, verifyOTP } from '../../utils/helpers';
import { sendEmail, sendSMS } from '../../utils/smsProvider';
import { issueTokenPair, storeRefreshToken, TokenPair } from '../auth/token.service';

const INVITE_EXPIRY_HOURS = 72;

export interface DoctorInviteInfo {
  doctor_id: string;
  user_id: string;
  masked_mobile?: string;
  masked_email?: string;
  invite_status: DoctorInviteStatus;
  expires_at: string;
}

export interface DoctorAuthResult {
  tokens: TokenPair;
  user: {
    id: string;
    mobile: string;
    role: UserRole;
    doctor_id: string;
    hospital_id?: string;
    account_status: AccountStatus;
  };
}

function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  return `${local.slice(0, 1)}${'*'.repeat(Math.max(local.length - 1, 3))}@${domain}`;
}

async function doctorWithUser(doctorId: string) {
  return DoctorProfile.findByPk(doctorId, {
    include: [{ model: User, as: 'user' }],
  }) as Promise<(DoctorProfile & { user?: User }) | null>;
}

export async function resolveDoctorIdentity(userId: string): Promise<ServiceResponse<{
  user: User;
  doctor: DoctorProfile;
  hospitalId?: string;
}>> {
  const user = await User.findByPk(userId);
  if (!user || user.role !== UserRole.DOCTOR) return fail('DOCTOR_NOT_FOUND', 'Doctor user not found.', 404);
  if (user.account_status === AccountStatus.SUSPENDED || user.deleted_at) {
    return fail('AUTH_ACCOUNT_SUSPENDED', 'Doctor account is suspended.', 403);
  }

  const doctor = await DoctorProfile.findOne({ where: { user_id: user.id } });
  if (!doctor || !doctor.is_active) return fail('DOCTOR_NOT_FOUND', 'Doctor profile not found.', 404);

  const affiliation = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctor.id, is_primary: true, is_active: true },
  }) ?? await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctor.id, is_active: true },
    order: [['created_at', 'ASC']],
  });

  return ok({ user, doctor, hospitalId: affiliation?.hospital_id ?? undefined });
}

async function issueDoctorTokens(user: User, doctor: DoctorProfile, hospitalId?: string): Promise<TokenPair> {
  const tokens = issueTokenPair({
    userId: user.id,
    role: user.role,
    accountStatus: user.account_status,
    hospitalId,
    doctorId: doctor.id,
  });
  await storeRefreshToken(user.id, tokens.refresh_token);
  return tokens;
}

async function findInviteByToken(token: string): Promise<DoctorProfile | null> {
  const tokenHash = hashInviteToken(token);
  return DoctorProfile.findOne({ where: { invite_token_hash: tokenHash } });
}

async function sendDoctorInviteMessage(doctor: DoctorProfile, user: User, token: string): Promise<void> {
  const inviteUrl = `${env.ADMIN_PANEL_URL.replace(/\/$/, '')}/doctor/accept-invite?token=${encodeURIComponent(token)}`;
  const text = `Welcome Dr. ${doctor.full_name}. Set up your Upcharify doctor workspace: ${inviteUrl}. This invite expires in ${INVITE_EXPIRY_HOURS} hours.`;

  if (!user.email) throw new Error('Doctor email is required to send workspace invite.');
  await sendEmail(
    user.email,
    'Set up your Upcharify Doctor Workspace',
    text,
    `<p>Welcome Dr. ${doctor.full_name},</p><p>Set up your Upcharify doctor workspace:</p><p><a href="${inviteUrl}">${inviteUrl}</a></p><p>This invite expires in ${INVITE_EXPIRY_HOURS} hours.</p>`,
  );
}

export async function resendDoctorInvite(
  doctorId: string,
  scopeHospitalId?: string,
): Promise<ServiceResponse<{ message: string; invite_status: DoctorInviteStatus; expires_at: string }>> {
  const doctor = await doctorWithUser(doctorId);
  if (!doctor) return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);
  const user = doctor.user;
  if (!user) return fail('DOCTOR_USER_NOT_FOUND', 'Doctor user not found.', 404);
  if (doctor.verification_status !== 'approved') return fail('DOCTOR_NOT_APPROVED', 'Approve doctor before sending workspace invite.', 422);
  if (user.account_status === AccountStatus.SUSPENDED) return fail('DOCTOR_SUSPENDED', 'Suspended doctors cannot receive invites.', 422);

  if (scopeHospitalId) {
    const aff = await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: doctor.id, hospital_id: scopeHospitalId, is_active: true },
    });
    if (!aff) return fail('FORBIDDEN', 'Doctor does not belong to your hospital.', 403);
  }

  const token = generateInviteToken();
  const expiresAt = addMinutes(new Date(), INVITE_EXPIRY_HOURS * 60);
  await doctor.update({
    invite_status: DoctorInviteStatus.PENDING_INVITE,
    invite_token_hash: hashInviteToken(token),
    invite_expires_at: expiresAt,
    invite_accepted_at: null,
    invite_sent_at: new Date(),
  });

  await sendDoctorInviteMessage(doctor, user, token);
  return ok({
    message: 'Doctor invite sent.',
    invite_status: DoctorInviteStatus.PENDING_INVITE,
    expires_at: expiresAt.toISOString(),
  });
}

export async function revokeDoctorInvite(
  doctorId: string,
  scopeHospitalId?: string,
): Promise<ServiceResponse<{ message: string; invite_status: DoctorInviteStatus }>> {
  const doctor = await DoctorProfile.findByPk(doctorId);
  if (!doctor) return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);

  if (scopeHospitalId) {
    const aff = await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: doctor.id, hospital_id: scopeHospitalId, is_active: true },
    });
    if (!aff) return fail('FORBIDDEN', 'Doctor does not belong to your hospital.', 403);
  }

  await doctor.update({
    invite_status: DoctorInviteStatus.REVOKED,
    invite_token_hash: null,
    invite_expires_at: null,
  });
  return ok({ message: 'Doctor invite revoked.', invite_status: DoctorInviteStatus.REVOKED });
}

export async function getInviteInfo(token: string): Promise<ServiceResponse<DoctorInviteInfo>> {
  const doctor = await findInviteByToken(token);
  if (!doctor) return fail('INVITE_INVALID', 'Invalid invite link.', 400);
  const user = await User.findByPk(doctor.user_id);
  if (!user) return fail('INVITE_INVALID', 'Doctor user not found.', 400);

  if (doctor.invite_status !== DoctorInviteStatus.PENDING_INVITE) {
    return fail('INVITE_UNAVAILABLE', 'Invite is no longer available.', 400);
  }
  if (!doctor.invite_expires_at || doctor.invite_expires_at < new Date()) {
    await doctor.update({ invite_status: DoctorInviteStatus.EXPIRED, invite_token_hash: null });
    return fail('INVITE_EXPIRED', 'Invite has expired.', 400);
  }

  return ok({
    doctor_id: doctor.id,
    user_id: user.id,
    masked_mobile: user.mobile ? maskMobile(user.mobile) : undefined,
    masked_email: user.email ? maskEmail(user.email) : undefined,
    invite_status: DoctorInviteStatus.PENDING_INVITE,
    expires_at: doctor.invite_expires_at.toISOString(),
  });
}

export async function sendDoctorOtp(input: { token: string }): Promise<ServiceResponse<{
  masked_mobile: string;
  expires_in: number;
  resend_allowed_in: number;
}>> {
  const invite = await getInviteInfo(input.token);
  if (!invite.success) return invite;
  const user = await User.findByPk(invite.data.user_id);

  if (!user || user.role !== UserRole.DOCTOR) return fail('DOCTOR_NOT_FOUND', 'Doctor account not found.', 404);
  if (user.account_status === AccountStatus.SUSPENDED) return fail('AUTH_ACCOUNT_SUSPENDED', 'Doctor account is suspended.', 403);

  const cooldownKey = RedisKeys.otpCooldown(`doctor:${user.mobile}`);
  const cooldownTTL = await redis.ttl(cooldownKey);
  if (cooldownTTL > 0) return fail('RATE_LIMIT_EXCEEDED', 'OTP already sent. Please wait before requesting again.', 429, { retry_after: cooldownTTL });

  const otp = generateOTP();
  await user.update({
    otp_secret: await hashOTP(otp),
    otp_expires_at: addMinutes(new Date(), env.OTP_EXPIRY_MINUTES),
    otp_attempts: 0,
  });
  await redis.setex(cooldownKey, RedisTTL.OTP_COOLDOWN, '1');
  await sendSMS(user.mobile, otp);

  return ok({
    masked_mobile: maskMobile(user.mobile),
    expires_in: env.OTP_EXPIRY_MINUTES * 60,
    resend_allowed_in: RedisTTL.OTP_COOLDOWN,
    ...(env.NODE_ENV !== 'production' && env.OTP_BYPASS_CODE ? { dev_otp: otp } : {}),
  });
}

async function verifyDoctorOtpForUser(user: User, otp: string): Promise<ServiceResponse<null>> {
  if (!user.otp_secret || !user.otp_expires_at) return fail('AUTH_OTP_INVALID', 'No OTP found. Please request a new one.', 401);
  if (user.otp_expires_at < new Date()) {
    await user.update({ otp_secret: null, otp_expires_at: null });
    return fail('AUTH_OTP_EXPIRED', 'OTP has expired.', 401);
  }

  if (user.otp_attempts >= env.OTP_MAX_ATTEMPTS) {
    await user.update({ otp_secret: null, otp_expires_at: null, otp_attempts: 0 });
    return fail('AUTH_OTP_MAX_ATTEMPTS', 'Too many failed attempts.', 423);
  }

  const bypassAllowed = env.OTP_BYPASS_CODE && otp === env.OTP_BYPASS_CODE &&
    (!env.OTP_BYPASS_MOBILE || user.mobile === env.OTP_BYPASS_MOBILE);
  const isValid = bypassAllowed || await verifyOTP(otp, user.otp_secret);
  if (!isValid) {
    await user.update({ otp_attempts: user.otp_attempts + 1 });
    return fail('AUTH_OTP_INVALID', 'Invalid OTP.', 401);
  }

  await user.update({
    otp_secret: null,
    otp_expires_at: null,
    otp_attempts: 0,
    account_status: AccountStatus.ACTIVE,
    last_login_at: new Date(),
  });
  await redis.del(RedisKeys.otpCooldown(`doctor:${user.mobile}`));
  return ok(null);
}

export async function acceptDoctorInvite(
  token: string,
  otp: string,
  password: string,
): Promise<ServiceResponse<DoctorAuthResult>> {
  const doctor = await findInviteByToken(token);
  if (!doctor) return fail('INVITE_INVALID', 'Invalid invite link.', 400);
  if (doctor.invite_status !== DoctorInviteStatus.PENDING_INVITE) return fail('INVITE_UNAVAILABLE', 'Invite is no longer available.', 400);
  if (!doctor.invite_expires_at || doctor.invite_expires_at < new Date()) {
    await doctor.update({ invite_status: DoctorInviteStatus.EXPIRED, invite_token_hash: null });
    return fail('INVITE_EXPIRED', 'Invite has expired.', 400);
  }

  const user = await User.findByPk(doctor.user_id);
  if (!user || user.role !== UserRole.DOCTOR) return fail('INVITE_INVALID', 'Doctor user not found.', 400);

  const verified = await verifyDoctorOtpForUser(user, otp);
  if (!verified.success) return verified;

  await user.update({ password_hash: await hashPassword(password), account_status: AccountStatus.ACTIVE });
  await doctor.update({
    invite_status: DoctorInviteStatus.ACCEPTED,
    invite_token_hash: null,
    invite_accepted_at: new Date(),
  });

  const identity = await resolveDoctorIdentity(user.id);
  if (!identity.success) return identity;
  const tokens = await issueDoctorTokens(identity.data.user, identity.data.doctor, identity.data.hospitalId);

  return ok({
    tokens,
    user: {
      id: user.id,
      mobile: maskMobile(user.mobile),
      role: user.role,
      doctor_id: doctor.id,
      hospital_id: identity.data.hospitalId,
      account_status: AccountStatus.ACTIVE,
    },
  });
}

export async function expireOldDoctorInvites(): Promise<void> {
  await DoctorProfile.update(
    { invite_status: DoctorInviteStatus.EXPIRED, invite_token_hash: null },
    {
      where: {
        invite_status: DoctorInviteStatus.PENDING_INVITE,
        invite_expires_at: { [Op.lt]: new Date() },
      },
    },
  );
}
