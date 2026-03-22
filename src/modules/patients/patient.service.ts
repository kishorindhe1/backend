import { PatientProfile } from '../../models';
import { User }           from '../../models';
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
