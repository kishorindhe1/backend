import { sequelize }        from '../../config/database';
import { User }              from '../../models';
import { DoctorProfile, VerificationStatus } from '../../models';
import { DoctorHospitalAffiliation }         from '../../models';
import { Hospital }          from '../../models';
import { Schedule }          from '../../models';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { logger }            from '../../utils/logger';

// ── Register doctor and affiliate to a hospital ───────────────────────────────
export interface RegisterDoctorInput {
  mobile:               string;
  full_name:            string;
  specialization:       string;
  qualifications:       string[];
  experience_years:     number;
  nmc_registration_number?: string;
  gender?:              string;
  languages_spoken?:    string[];
  consultation_fee:     number;
  hospital_id:          string;
  room_number?:         string;
  department?:          string;
}

export async function registerDoctor(
  input: RegisterDoctorInput,
): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(input.hospital_id);
  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);

  // Check if mobile already exists
  const existing = await User.findOne({ where: { mobile: input.mobile } });
  let userId: string;

  if (existing) {
    if (existing.role !== UserRole.DOCTOR) {
      return fail('USER_ROLE_CONFLICT', 'This mobile is registered with a different role.', 409);
    }
    userId = existing.id;
  } else {
    // Create user record
    const user = await User.create({
      mobile:         input.mobile,
      country_code:   '+91',
      role:           UserRole.DOCTOR,
      account_status: AccountStatus.ACTIVE,
      otp_secret:     null,
      otp_expires_at: null,
      otp_attempts:   0,
      last_login_at:  null,
      deleted_at:     null,
    });
    userId = user.id;
  }

  // Create doctor profile if not exists
  let doctorProfile = await DoctorProfile.findOne({ where: { user_id: userId } });
  if (!doctorProfile) {
    doctorProfile = await DoctorProfile.create({
      user_id:                 userId,
      full_name:               input.full_name,
      specialization:          input.specialization,
      qualifications:          input.qualifications,
      experience_years:        input.experience_years,
      languages_spoken:        input.languages_spoken ?? ['english'],
      gender:                  input.gender ?? null,
      nmc_registration_number: input.nmc_registration_number ?? null,
      profile_photo_url:       null,
      bio:                     null,
      verification_status:     VerificationStatus.PENDING,
      verified_at:             null,
      verified_by:             null,
      is_active:               true,
      deleted_at:              null,
    });
  }

  // Create affiliation — skip if already affiliated
  const existingAff = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorProfile.id, hospital_id: input.hospital_id },
  });

  if (!existingAff) {
    await DoctorHospitalAffiliation.create({
      doctor_id:        doctorProfile.id,
      hospital_id:      input.hospital_id,
      is_primary:       true,
      consultation_fee: input.consultation_fee,
      room_number:      input.room_number ?? null,
      department:       input.department  ?? null,
      is_active:        true,
      start_date:       new Date(),
      end_date:         null,
    });
  }

  logger.info('Doctor registered', { doctorProfileId: doctorProfile.id, hospitalId: input.hospital_id });

  return ok({
    doctor_profile_id: doctorProfile.id,
    user_id:           userId,
    full_name:         doctorProfile.full_name,
    specialization:    doctorProfile.specialization,
    verification_status: doctorProfile.verification_status,
    message: 'Doctor registered. Pending NMC verification before going live.',
  });
}

// ── Get doctor public profile ─────────────────────────────────────────────────
export async function getDoctorProfile(doctorProfileId: string): Promise<ServiceResponse<object>> {
  const doctor = await DoctorProfile.findByPk(doctorProfileId, {
    include: [
      {
        model: DoctorHospitalAffiliation,
        as: 'affiliations',
        where: { is_active: true },
        required: false,
        include: [{ model: Hospital, as: 'hospital',
          attributes: ['id', 'name', 'city', 'address_line1', 'phone_primary'] }],
      },
    ],
  });

  if (!doctor) return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);
  if (!doctor.is_active) return fail('DOCTOR_SUSPENDED', 'Doctor profile is not active.', 403);

  return ok(doctor);
}

// ── List doctors — filtered search ───────────────────────────────────────────
export async function listDoctors(filters: {
  specialization?: string;
  city?:           string;
  hospital_id?:    string;
  page:            number;
  perPage:         number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { Op } = await import('sequelize');
  const { page, perPage } = filters;

  const hospitalWhere: Record<string, unknown> = {};
  if (filters.city)        hospitalWhere.city = { [Op.iLike]: `%${filters.city}%` };
  if (filters.hospital_id) hospitalWhere.id   = filters.hospital_id;

  const where: Record<string, unknown> = {
    is_active:          true,
    verification_status: VerificationStatus.APPROVED,
  };
  if (filters.specialization) where.specialization = { [Op.iLike]: `%${filters.specialization}%` };

  const { rows, count } = await DoctorProfile.findAndCountAll({
    where,
    include: [{
      model: DoctorHospitalAffiliation,
      as: 'affiliations',
      required: true,
      where: { is_active: true },
      include: [{
        model: Hospital,
        as: 'hospital',
        attributes: ['id', 'name', 'city', 'address_line1'],
        where: Object.keys(hospitalWhere).length ? hospitalWhere : undefined,
        required: Object.keys(hospitalWhere).length > 0,
      }],
    }],
    limit:  perPage,
      subQuery: false, // 🔥 THIS FIXES YOUR EXACT ISSUE

    offset: (page - 1) * perPage,
    order:  [['reliability_score', 'DESC']],
    distinct: true,
  });

  return ok({ rows, count });
}

// ── Create schedule for a doctor ──────────────────────────────────────────────
export interface CreateScheduleInput {
  doctor_id:             string;
  hospital_id:           string;
  day_of_week:           string;
  start_time:            string;
  end_time:              string;
  slot_duration_minutes: number;
  max_patients:          number;
  session_type?:         string;
  effective_from:        string;
  effective_until?:      string;
}

export async function createSchedule(
  input: CreateScheduleInput,
): Promise<ServiceResponse<object>> {
  // Validate doctor is affiliated with hospital
  const affiliation = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: input.doctor_id, hospital_id: input.hospital_id, is_active: true },
  });
  if (!affiliation) {
    return fail('DOCTOR_NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.', 422);
  }

  const schedule = await Schedule.create({
    doctor_id:             input.doctor_id,
    hospital_id:           input.hospital_id,
    day_of_week:           input.day_of_week as Schedule['day_of_week'],
    start_time:            input.start_time,
    end_time:              input.end_time,
    slot_duration_minutes: input.slot_duration_minutes,
    max_patients:          input.max_patients,
    session_type:          (input.session_type ?? 'opd') as Schedule['session_type'],
    effective_from:        new Date(input.effective_from),
    effective_until:       input.effective_until ? new Date(input.effective_until) : null,
    is_active:             true,
  });

  logger.info('Schedule created', { scheduleId: schedule.id, doctorId: input.doctor_id });

  return ok(schedule);
}

// ── Verify doctor (admin action) ──────────────────────────────────────────────
export async function verifyDoctor(
  doctorProfileId: string,
  adminUserId:     string,
  action:          'approve' | 'reject',
): Promise<ServiceResponse<object>> {
  const doctor = await DoctorProfile.findByPk(doctorProfileId);
  if (!doctor) return fail('DOCTOR_NOT_FOUND', 'Doctor not found.', 404);

  const status = action === 'approve'
    ? VerificationStatus.APPROVED
    : VerificationStatus.REJECTED;

  await doctor.update({
    verification_status: status,
    verified_at:         action === 'approve' ? new Date() : null,
    verified_by:         action === 'approve' ? adminUserId : null,
  });

  logger.info(`Doctor ${action}d`, { doctorProfileId, adminUserId });
  return ok({ message: `Doctor ${action}d successfully.`, verification_status: status });
}
