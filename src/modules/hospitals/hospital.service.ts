import { Hospital, HospitalType, OnboardingStatus, AppointmentApprovalMode } from '../../models';
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

// ── Haversine distance in km ──────────────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── List live hospitals ───────────────────────────────────────────────────────
export async function listHospitals(filters: {
  city?:   string;
  lat?:    number;
  lng?:    number;
  page:    number;
  perPage: number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { Op } = await import('sequelize');
  const where: Record<string, unknown> = { onboarding_status: OnboardingStatus.LIVE };

  const hasCoords = filters.lat != null && filters.lng != null;

  if (!hasCoords && filters.city) {
    // City-only filter (old behaviour)
    where.city = { [Op.iLike]: `%${filters.city}%` };
  }

  if (hasCoords) {
    // Fetch all live hospitals that have coordinates, compute distance in JS,
    // sort by proximity, then paginate.
    where.latitude  = { [Op.ne]: null };
    where.longitude = { [Op.ne]: null };

    const all = await Hospital.findAll({ where });

    type HospitalWithDist = Hospital & { distance_km: number };
    const withDist: HospitalWithDist[] = (all as HospitalWithDist[])
      .map((h) => {
        h.distance_km = haversineKm(
          filters.lat!,
          filters.lng!,
          parseFloat(String(h.latitude)),
          parseFloat(String(h.longitude)),
        );
        return h;
      })
      .filter((h) => h.distance_km <= 50)   // within 50 km
      .sort((a, b) => a.distance_km - b.distance_km);

    const count  = withDist.length;
    const offset = (filters.page - 1) * filters.perPage;
    const rows   = withDist.slice(offset, offset + filters.perPage).map((h) => ({
      ...h.toJSON(),
      distance_km: Math.round(h.distance_km * 10) / 10,
    }));

    return ok({ rows, count });
  }

  // Default: paginated, sorted by name
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

// ── Update appointment approval mode ──────────────────────────────────────────
export async function updateAppointmentApprovalMode(
  hospitalId: string,
  mode:       AppointmentApprovalMode,
  requesterId: string,
): Promise<ServiceResponse<{ appointment_approval: AppointmentApprovalMode }>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);

  // Verify the requester is an admin of this hospital
  const staff = await HospitalStaff.findOne({
    where: { hospital_id: hospitalId, user_id: requesterId, is_active: true },
  });
  if (!staff) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'You are not an admin of this hospital.', 403);

  await hospital.update({ appointment_approval: mode });
  logger.info('Hospital approval mode updated', { hospitalId, mode, requesterId });
  return ok({ appointment_approval: hospital.appointment_approval });
}
