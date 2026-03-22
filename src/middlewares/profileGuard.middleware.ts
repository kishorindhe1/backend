import { Request, Response, NextFunction } from 'express';
import { PatientProfile } from '../models';
import { getMissingFields, getCompletionPercentage } from '../utils/helpers';
import { ProfileStatus, JwtAccessPayload, UserRole } from '../types';
import { sendForbidden } from '../utils/response';

export async function requireCompleteProfile(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = req.user as JwtAccessPayload;
  if (user.role !== UserRole.PATIENT) { next(); return; }
  if (user.profile_status === ProfileStatus.COMPLETE) { next(); return; }

  const profile = await PatientProfile.findOne({ where: { user_id: user.sub } });
  if (!profile) {
    sendForbidden(res, 'PROFILE_NOT_FOUND', 'Patient profile not found.', { completion_url: '/api/v1/patients/me/complete-profile' });
    return;
  }
  if (profile.profile_status !== ProfileStatus.COMPLETE) {
    sendForbidden(res, 'PROFILE_INCOMPLETE', 'Please complete your profile before proceeding.', {
      missing_fields:        getMissingFields(profile),
      completion_url:        '/api/v1/patients/me/complete-profile',
      completion_percentage: getCompletionPercentage(profile),
    });
    return;
  }
  next();
}
