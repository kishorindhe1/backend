import { PatientProfile } from '../../models';
import { User }           from '../../models';
import { HealthRecord, RecordType } from '../../models';
import { issueTokenPair, storeRefreshToken } from '../auth/token.service';
import { ProfileStatus, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { getMissingFields, getCompletionPercentage } from '../../utils/helpers';
import { CompleteProfileInput, UpdateProfileInput }  from './patient.validation';
import { logger } from '../../utils/logger';

export async function getMyProfile(userId: string): Promise<ServiceResponse<object>> {
  const user    = await User.findByPk(userId);
  if (!user) return fail('PROFILE_NOT_FOUND', 'User not found.', 404);
  const profile = await PatientProfile.findOne({ where: { user_id: userId } });
  if (!profile) return fail('PROFILE_NOT_FOUND', 'Profile not found.', 404);
  return ok({
    id: user.id, mobile: user.mobile, country_code: user.country_code,
    role: user.role, account_status: user.account_status,
    profile_status: profile.profile_status,
    completion_percentage: getCompletionPercentage(profile),
    missing_fields:        getMissingFields(profile),
    profile: { full_name: profile.full_name, email: profile.email, date_of_birth: profile.date_of_birth, gender: profile.gender, blood_group: profile.blood_group, profile_photo_url: profile.profile_photo_url },
    created_at: user.created_at,
  });
}

export interface CompleteProfileResult {
  profile_status: ProfileStatus; completion_percentage: number;
  new_access_token: string; new_refresh_token: string; expires_in: number;
}

export async function completeProfile(userId: string, input: CompleteProfileInput): Promise<ServiceResponse<CompleteProfileResult>> {
  const user    = await User.findByPk(userId);
  if (!user) return fail('PROFILE_NOT_FOUND', 'User not found.', 404);
  const profile = await PatientProfile.findOne({ where: { user_id: userId } });
  if (!profile) return fail('PROFILE_NOT_FOUND', 'Profile not found.', 404);

  await profile.update({
    full_name: input.full_name,
    date_of_birth: input.date_of_birth ? new Date(input.date_of_birth) : null,
    gender: input.gender, email: input.email || null, blood_group: input.blood_group || null,
    profile_status: ProfileStatus.COMPLETE, completed_at: new Date(),
  });

  const tokens = issueTokenPair({ userId: user.id, role: user.role, accountStatus: AccountStatus.ACTIVE, profileStatus: ProfileStatus.COMPLETE });
  await storeRefreshToken(user.id, tokens.refresh_token);
  logger.info('Patient profile completed', { userId });
  return ok({ profile_status: ProfileStatus.COMPLETE, completion_percentage: getCompletionPercentage(profile), new_access_token: tokens.access_token, new_refresh_token: tokens.refresh_token, expires_in: tokens.expires_in });
}

// ── Health Records ────────────────────────────────────────────────────────────
export async function createHealthRecord(userId: string, input: {
  title: string; record_type: RecordType; file_url: string; file_name: string;
  file_size?: number; mime_type?: string; notes?: string; record_date?: string;
}): Promise<ServiceResponse<object>> {
  const record = await HealthRecord.create({
    patient_id:  userId,
    title:       input.title,
    record_type: input.record_type,
    file_url:    input.file_url,
    file_name:   input.file_name,
    file_size:   input.file_size ?? null,
    mime_type:   input.mime_type ?? null,
    notes:       input.notes    ?? null,
    record_date: input.record_date ? new Date(input.record_date) : null,
  });
  return ok(record);
}

export async function getHealthRecords(
  userId: string,
  page: number,
  perPage: number,
  recordType?: string,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = { patient_id: userId };
  if (recordType) where.record_type = recordType;

  const { rows, count } = await HealthRecord.findAndCountAll({
    where,
    order:  [['created_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });

  // Map to the field names expected by the mobile app
  const mapped = rows.map(r => {
    const json = r.toJSON() as Record<string, unknown>;
    return { ...json, name: json.title, recorded_at: json.record_date };
  });

  return ok({ rows: mapped, count });
}

export async function getHealthRecord(userId: string, recordId: string): Promise<ServiceResponse<object>> {
  const record = await HealthRecord.findOne({ where: { id: recordId, patient_id: userId } });
  if (!record) return fail('RECORD_NOT_FOUND', 'Health record not found.', 404);
  return ok(record);
}

export async function deleteHealthRecord(userId: string, recordId: string): Promise<ServiceResponse<{ message: string }>> {
  const record = await HealthRecord.findOne({ where: { id: recordId, patient_id: userId } });
  if (!record) return fail('RECORD_NOT_FOUND', 'Health record not found.', 404);
  await record.destroy();
  return ok({ message: 'Health record deleted.' });
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<ServiceResponse<object>> {
  const profile = await PatientProfile.findOne({ where: { user_id: userId } });
  if (!profile) return fail('PROFILE_NOT_FOUND', 'Profile not found.', 404);

  const updates: Partial<{ full_name: string; email: string | null; blood_group: string; gender: typeof profile.gender; date_of_birth: Date; }> = {};
  if (input.full_name    !== undefined) updates.full_name    = input.full_name;
  if (input.gender       !== undefined) updates.gender       = input.gender as typeof profile.gender;
  if (input.email        !== undefined) updates.email        = input.email || null;
  if (input.blood_group  !== undefined) updates.blood_group  = input.blood_group;
  if (input.date_of_birth !== undefined) updates.date_of_birth = new Date(input.date_of_birth);

  await profile.update(updates);
  const missing = getMissingFields(profile);
  if (missing.length === 0 && profile.profile_status !== ProfileStatus.COMPLETE) {
    await profile.update({ profile_status: ProfileStatus.COMPLETE, completed_at: new Date() });
  }
  logger.info('Patient profile updated', { userId });
  return ok({ profile_status: profile.profile_status, completion_percentage: getCompletionPercentage(profile), missing_fields: getMissingFields(profile) });
}

export async function updateProfilePhotoUrl(userId: string, photoUrl: string): Promise<ServiceResponse<object>> {
  const profile = await PatientProfile.findOne({ where: { user_id: userId } });
  if (!profile) return fail('PROFILE_NOT_FOUND', 'Profile not found.', 404);
  await profile.update({ profile_photo_url: photoUrl });
  return ok({ profile_photo_url: photoUrl });
}
