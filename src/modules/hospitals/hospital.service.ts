import crypto from 'crypto';
import { Hospital, HospitalType, OnboardingStatus, AppointmentApprovalMode, PaymentCollectionMode } from '../../models';
import { HospitalStaff, StaffRole }                 from '../../models';
import { User }                from '../../models';
import { UserRole, AccountStatus, ServiceResponse, ok, fail } from '../../types';
import { logger }              from '../../utils/logger';
import { hashOTP }             from '../../utils/helpers';
import { sendEmail }           from '../../utils/smsProvider';
import { renderEmailTemplate, EMAIL_SUBJECTS } from '../../templates/email';
import { env }                 from '../../config/env';

// ── Register hospital ─────────────────────────────────────────────────────────
export interface RegisterHospitalInput {
  admin_mobile:  string;
  admin_name:    string;
  admin_email:   string;
  hospital_name: string;
  city:          string;
  state:         string;
  hospital_type: string;
}

export async function registerHospital(
  input: RegisterHospitalInput,
): Promise<ServiceResponse<object>> {
  // Check email uniqueness before creating
  const existingEmail = await User.findOne({ where: { email: input.admin_email } });
  if (existingEmail) return fail('EMAIL_TAKEN', 'This email address is already in use.', 409);

  // Find or create admin user
  const [adminUser] = await User.findOrCreate({
    where: { mobile: input.admin_mobile },
    defaults: {
      mobile:         input.admin_mobile,
      email:          input.admin_email,
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

  // Save email if user already existed without one
  if (!adminUser.email) {
    await adminUser.update({ email: input.admin_email, role: UserRole.HOSPITAL_ADMIN });
  }

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

  if (newStatus === OnboardingStatus.LIVE) {
    await sendHospitalInvite(hospitalId, hospital.name).catch((err) =>
      logger.error('Failed to send hospital invite email', { hospitalId, err }),
    );
  }

  return ok({ hospital_id: hospitalId, onboarding_status: newStatus });
}

async function sendHospitalInvite(hospitalId: string, hospitalName: string): Promise<void> {
  const staffRecord = await HospitalStaff.findOne({
    where: { hospital_id: hospitalId, is_active: true },
    include: [{ model: User, as: 'user' }],
    order: [['created_at', 'ASC']],
  });

  const adminUser = (staffRecord as HospitalStaff & { user?: User })?.user;
  if (!adminUser?.email) {
    logger.warn('No admin email found for hospital invite', { hospitalId });
    return;
  }

  // Generate a secure 48-hour invite token
  const rawToken    = crypto.randomBytes(32).toString('hex');
  const tokenHash   = await hashOTP(rawToken);
  const expiresAt   = new Date(Date.now() + 48 * 60 * 60 * 1000);

  await adminUser.update({ otp_secret: tokenHash, otp_expires_at: expiresAt, otp_attempts: 0 });

  const inviteUrl = `${env.ADMIN_PANEL_URL}/accept-invite?token=${rawToken}&email=${encodeURIComponent(adminUser.email)}`;

  const html = renderEmailTemplate('hospital_invite', {
    hospital_name: hospitalName,
    invite_url:    inviteUrl,
  });

  await sendEmail(
    adminUser.email,
    EMAIL_SUBJECTS['hospital_invite'] ?? `Welcome to Upcharify — Set Up Your Account`,
    `Your hospital "${hospitalName}" is now live on Upcharify. Set up your admin account: ${inviteUrl}`,
    html,
  );

  logger.info('Hospital invite email sent', { hospitalId, adminEmail: adminUser.email });
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
  q?:            string;
  city?:         string;
  hospital_type?: string;
  lat?:          number;
  lng?:          number;
  page:          number;
  perPage:       number;
}): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { Op } = await import('sequelize');
  const where: Record<string, unknown> = { onboarding_status: OnboardingStatus.LIVE };

  const hasCoords = filters.lat != null && filters.lng != null;

  if (filters.hospital_type) {
    where.hospital_type = filters.hospital_type;
  }

  if (filters.q) {
    where.name = { [Op.iLike]: `%${filters.q}%` };
  } else if (!hasCoords && filters.city) {
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

// ── Update payment collection mode ────────────────────────────────────────────
export async function updatePaymentCollectionMode(
  hospitalId: string,
  mode:       PaymentCollectionMode,
  requesterId: string,
): Promise<ServiceResponse<{ payment_collection_mode: PaymentCollectionMode }>> {
  const hospital = await Hospital.findByPk(hospitalId);
  if (!hospital) return fail('HOSPITAL_NOT_FOUND', 'Hospital not found.', 404);

  const staff = await HospitalStaff.findOne({
    where: { hospital_id: hospitalId, user_id: requesterId, is_active: true },
  });
  if (!staff) return fail('AUTH_INSUFFICIENT_PERMISSIONS', 'You are not an admin of this hospital.', 403);

  await hospital.update({ payment_collection_mode: mode });
  logger.info('Hospital payment collection mode updated', { hospitalId, mode, requesterId });
  return ok({ payment_collection_mode: hospital.payment_collection_mode });
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
