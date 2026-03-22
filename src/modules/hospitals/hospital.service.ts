import { Hospital, HospitalType, OnboardingStatus } from '../../models';
import { HospitalStaff, StaffRole }                 from '../../models';
import { User }                from '../../models';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { logger }              from '../../utils/logger';

// ── Register hospital ─────────────────────────────────────────────────────────
export interface RegisterHospitalInput {
  admin_mobile:  string;
  admin_name:    string;
  hospital_name: string;
  city:          string;
  state:         string;
  hospital_type: string;
}

export async function registerHospital(
  input: RegisterHospitalInput,
): Promise<ServiceResponse<object>> {
  // Find or create admin user
  const [adminUser] = await User.findOrCreate({
    where: { mobile: input.admin_mobile },
    defaults: {
      mobile:         input.admin_mobile,
      country_code:   '+91',
      role:           UserRole.HOSPITAL_ADMIN,
      account_status: AccountStatus.ACTIVE,
      otp_secret:     null,
      otp_expires_at: null,
      otp_attempts:   0,
      last_login_at:  null,
      deleted_at:     null,
    },
  });

  // Create hospital
  const hospital = await Hospital.create({
    name:              input.hospital_name,
    legal_name:        null,
    registration_number: null,
    hospital_type:     input.hospital_type as HospitalType,
    onboarding_status: OnboardingStatus.REGISTERED,
    city:              input.city,
    state:             input.state,
    phone_primary:     null,
    email_general:     null,
    website:           null,
    address_line1:     null,
    address_line2:     null,
    pincode:           null,
    latitude:          null,
    longitude:         null,
    is_verified:       false,
    went_live_at:      null,
    suspended_at:      null,
    suspension_reason: null,
    deleted_at:        null,
  });

  // Link admin user to hospital
  await HospitalStaff.create({
    user_id:     adminUser.id,
    hospital_id: hospital.id,
    staff_role:  StaffRole.HOSPITAL_ADMIN,
    department:  null,
    employee_id: null,
    is_active:   true,
    joined_at:   new Date(),
  });

  logger.info('Hospital registered', { hospitalId: hospital.id, adminMobile: input.admin_mobile });

  return ok({
    hospital_id:       hospital.id,
    name:              hospital.name,
    onboarding_status: hospital.onboarding_status,
    admin_user_id:     adminUser.id,
    message:           'Hospital registered. Complete onboarding to go live.',
  });
}

// ── Update hospital onboarding status ────────────────────────────────────────
export async function updateOnboardingStatus(
  hospitalId: string,
  newStatus:  OnboardingStatus,
  adminId:    string,
): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);

  const updates: Partial<Hospital> = { onboarding_status: newStatus };
  if (newStatus === OnboardingStatus.LIVE) {
    updates.went_live_at  = new Date();
    updates.is_verified   = true;
  }
  if (newStatus === OnboardingStatus.SUSPENDED) {
    updates.suspended_at = new Date();
  }

  await hospital.update(updates);
  logger.info('Hospital onboarding status updated', { hospitalId, newStatus, adminId });

  return ok({ hospital_id: hospitalId, onboarding_status: newStatus });
}

// ── Get hospital by ID ────────────────────────────────────────────────────────
export async function getHospital(hospitalId: string): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(hospitalId, {
    include: [{
      model: HospitalStaff,
      as: 'staff',
      where: { is_active: true },
      required: false,
      include: [{ model: User, as: 'user', attributes: ['id', 'mobile', 'role'] }],
    }],
  });

  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);
  return ok(hospital);
}

// ── List live hospitals ───────────────────────────────────────────────────────
export async function listHospitals(filters: {
  city?:   string;
  page:    number;
  perPage: number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { Op } = await import('sequelize');
  const where: Record<string, unknown> = { onboarding_status: OnboardingStatus.LIVE };
  if (filters.city) where.city = { [Op.iLike]: `%${filters.city}%` };

  const { rows, count } = await Hospital.findAndCountAll({
    where,
    limit:  filters.perPage,
    offset: (filters.page - 1) * filters.perPage,
    order:  [['name', 'ASC']],
  });

  return ok({ rows, count });
}

// ── Add receptionist to hospital ──────────────────────────────────────────────
export async function addReceptionist(
  hospitalId:  string,
  mobile:      string,
  department?: string,
): Promise<ServiceResponse<object>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);

  const [user] = await User.findOrCreate({
    where: { mobile },
    defaults: {
      mobile, country_code: '+91',
      role:           UserRole.RECEPTIONIST,
      account_status: AccountStatus.ACTIVE,
      otp_secret:     null, otp_expires_at: null, otp_attempts: 0,
      last_login_at:  null, deleted_at:     null,
    },
  });

  const [staff, created] = await HospitalStaff.findOrCreate({
    where: { user_id: user.id, hospital_id: hospitalId },
    defaults: {
      user_id: user.id, hospital_id: hospitalId,
      staff_role:  StaffRole.RECEPTIONIST,
      department:  department ?? null,
      employee_id: null,
      is_active:   true,
      joined_at:   new Date(),
    },
  });

  if (!created) await staff.update({ is_active: true });

  return ok({
    staff_id: staff.id, user_id: user.id, mobile,
    staff_role: StaffRole.RECEPTIONIST, hospital_id: hospitalId,
    message: created ? 'Receptionist added.' : 'Receptionist reactivated.',
  });
}
