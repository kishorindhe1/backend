import { Router, Request, Response }     from 'express';
import * as AdminService                  from './admin.service';
import * as DoctorAuthService             from '../doctor-auth/doctor-auth.service';
import { authenticate, requireRole }      from '../../middlewares/auth.middleware';
import { requirePermission, scopedHospitalId, Permission } from '../../middlewares/permission.middleware';
import { validate }                       from '../../middlewares/validate.middleware';
import { sendSuccess, sendError }         from '../../utils/response';
import { JwtAccessPayload, UserRole }     from '../../types';
import { asyncHandler }                   from '../../utils/asyncHandler';
import {
  Appointment, User, PatientProfile,
  DoctorProfile, OpdSlotSession,
}                                         from '../../models';
import { z }                              from 'zod';

const param = (req: Request, k: string) => String((req.params as Record<string, string>)[k] ?? '');
const qs    = (req: Request, k: string, d = '') => String((req.query  as Record<string, string>)[k] ?? d);
const page  = (req: Request) => Math.max(1, parseInt(qs(req, 'page', '1'), 10));
const perPg = (req: Request) => Math.min(100, Math.max(1, parseInt(qs(req, 'per_page', '20'), 10)));
const boolQs = (req: Request, k: string) => ['1', 'true', 'yes'].includes(qs(req, k).toLowerCase());

// ── Validation schemas ────────────────────────────────────────────────────────
const ToggleDoctorSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ action: z.enum(['suspend', 'reactivate']) }),
});
const VerifyDoctorSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ action: z.enum(['approve', 'reject']), notes: z.string().max(500).optional() }),
});
const ToggleHospitalSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ action: z.enum(['suspend', 'activate']), reason: z.string().max(300).optional() }),
});
const TogglePatientSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ action: z.enum(['suspend', 'activate']) }),
});
const PeriodSchema = z.object({
  query: z.object({ period: z.enum(['today', 'week', 'month']).default('today') }),
});
const UuidParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// All admin routes require authentication + at minimum HOSPITAL_ADMIN role
router.use(authenticate, requireRole(UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN));

// ══════════════════════════════════════════════════════════════════════════════
//  SHARED — SUPER_ADMIN + HOSPITAL_ADMIN (scoped)
// ══════════════════════════════════════════════════════════════════════════════

// Dashboard
router.get('/dashboard',
  requirePermission(Permission.PLATFORM_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.getPlatformHealth();
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Operations alerts
router.get('/alerts',
  requirePermission(Permission.PLATFORM_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.getOperationsAlerts();
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Financial summary — scoped for HOSPITAL_ADMIN
router.get('/financial',
  requirePermission(Permission.FINANCIALS_READ),
  validate(PeriodSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const period   = qs(req, 'period', 'today') as 'today' | 'week' | 'month';
    const scopeId  = scopedHospitalId(req);
    const result   = scopeId
      ? await AdminService.getScopedFinancialSummary(period, scopeId)
      : await AdminService.getFinancialSummary(period);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Revenue time-series for chart — scoped to own hospital for HOSPITAL_ADMIN
router.get('/financial/chart',
  requirePermission(Permission.FINANCIALS_READ),
  validate(PeriodSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const period  = qs(req, 'period', 'week') as 'today' | 'week' | 'month';
    const scopeId = scopedHospitalId(req);
    const result  = scopeId
      ? await AdminService.getScopedRevenueTimeSeries(period, scopeId)
      : await AdminService.getRevenueTimeSeries(period);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Doctor list — scoped for HOSPITAL_ADMIN
router.get('/doctors',
  requirePermission(Permission.DOCTORS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const scopeId = scopedHospitalId(req);
    const result  = await AdminService.listDoctorsScoped({
      hospital_id:         scopeId ?? (qs(req, 'hospital_id') || undefined),
      verification_status: qs(req, 'verification_status') || undefined,
      page:  page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

router.post('/doctors/:id/resend-invite',
  requirePermission(Permission.DOCTORS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DoctorAuthService.resendDoctorInvite(param(req, 'id'), scopedHospitalId(req));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.post('/doctors/:id/revoke-invite',
  requirePermission(Permission.DOCTORS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DoctorAuthService.revokeDoctorInvite(param(req, 'id'), scopedHospitalId(req));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Appointments list — scoped for HOSPITAL_ADMIN
router.get('/appointments',
  requirePermission(Permission.APPOINTMENTS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const user    = req.user as JwtAccessPayload;
    const scopeId = scopedHospitalId(req);
    const result  = await AdminService.listAppointments({
      hospital_id: scopeId ?? (qs(req, 'hospital_id') || undefined),
      doctor_id:   qs(req, 'doctor_id') || undefined,
      patient_id:  qs(req, 'patient_id') || undefined,
      status:      qs(req, 'status') || undefined,
      date:        qs(req, 'date') || undefined,
      search:      qs(req, 'search') || qs(req, 'q') || undefined,
      payment_status: qs(req, 'payment_status') || qs(req, 'payment') || undefined,
      stale_only:  boolQs(req, 'stale_only') || boolQs(req, 'stale'),
      page:  page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

// Single appointment detail — used by admin panel slot/appointment drawer
router.get('/appointments/:id',
  requirePermission(Permission.APPOINTMENTS_READ),
  validate(z.object({ params: z.object({ id: z.string().uuid() }) })),
  asyncHandler(async (req: Request, res: Response) => {
    const appt = await Appointment.findByPk(param(req, 'id'), {
      include: [
        {
          model: User, as: 'patient', attributes: ['id', 'mobile'],
          include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name', 'gender', 'date_of_birth'], required: false }],
        },
        { model: DoctorProfile, as: 'doctor', attributes: ['id', 'full_name', 'specialization'] },
        { model: OpdSlotSession, as: 'slot', attributes: ['slot_start_time', 'slot_end_time', 'date'], required: false },
      ],
    });
    if (!appt) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Appointment not found.' }); return; }

    const scopeId = scopedHospitalId(req);
    if (scopeId && appt.hospital_id !== scopeId) {
      sendError(res, 403, { code: 'FORBIDDEN', message: 'This appointment does not belong to your hospital.' });
      return;
    }

    const patientUser   = appt.get('patient') as (User & { patientProfile?: PatientProfile }) | null;
    const patientProfile = patientUser?.get('patientProfile') as PatientProfile | null;
    const doctor         = appt.get('doctor') as DoctorProfile | null;
    const slot           = appt.get('slot') as OpdSlotSession | null;

    sendSuccess(res, {
      id:               appt.id,
      status:           appt.status,
      payment_status:   appt.payment_status,
      appointment_type: appt.appointment_type,
      payment_mode:     appt.payment_mode,
      consultation_fee: Number(appt.consultation_fee),
      platform_fee:     Number(appt.platform_fee),
      scheduled_at:     appt.scheduled_at,
      cancelled_at:     appt.cancelled_at,
      cancellation_reason: appt.cancellation_reason,
      chief_complaint:  appt.chief_complaint,
      visit_type:       appt.visit_type,
      priority_tier:    appt.priority_tier,
      patient: patientUser ? {
        id:            patientUser.id,
        mobile:        patientUser.mobile,
        full_name:     patientProfile?.full_name ?? null,
        gender:        patientProfile?.gender ?? null,
        date_of_birth: patientProfile?.date_of_birth ?? null,
      } : null,
      doctor: doctor ? {
        id:             doctor.id,
        full_name:      doctor.full_name,
        specialization: doctor.specialization,
      } : null,
      slot: slot ? {
        date:           slot.date,
        start_time:     slot.slot_start_time,
        end_time:       slot.slot_end_time,
      } : null,
    });
  }),
);

// Reschedule an appointment (with hospital scope check)
router.put('/appointments/:id/reschedule',
  requirePermission(Permission.APPOINTMENTS_READ),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({
      slot_id: z.string().uuid('Invalid slot ID'),
      reason:  z.string().max(300).optional(),
    }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const { slot_id, reason } = req.body as { slot_id: string; reason?: string };
    const result = await AdminService.rescheduleAppointmentAsAdmin(
      param(req, 'id'),
      scopedHospitalId(req) ?? null,
      slot_id,
      reason,
    );
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Send push/SMS reminder for a specific appointment
router.post('/appointments/:id/reminder',
  requirePermission(Permission.APPOINTMENTS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const result = await AdminService.sendAppointmentReminder(param(req, 'id'), user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Hospital admin — view their own hospital detail + staff
router.get('/my-hospital',
  requirePermission(Permission.HOSPITALS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    if (!user.hospital_id) { sendError(res, 400, { code: 'NO_HOSPITAL', message: 'No hospital associated with your account.' }); return; }
    const result = await AdminService.getHospitalDetail(user.hospital_id);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Hospital admin — update their own hospital's contact & address details
router.patch('/my-hospital',
  requireRole(UserRole.HOSPITAL_ADMIN),
  validate(z.object({
    body: z.object({
      name:            z.string().trim().min(2).max(200).optional(),
      phone_primary:   z.string().trim().max(20).nullable().optional(),
      phone_secondary: z.string().trim().max(20).nullable().optional(),
      email_general:   z.string().email().nullable().optional(),
      website:         z.string().trim().max(255).nullable().optional(),
      address_line1:   z.string().trim().max(255).nullable().optional(),
      address_line2:   z.string().trim().max(255).nullable().optional(),
      city:            z.string().trim().min(2).max(100).optional(),
      state:           z.string().trim().min(2).max(100).optional(),
      pincode:         z.string().trim().max(10).nullable().optional(),
    }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    if (!user.hospital_id) { sendError(res, 400, { code: 'NO_HOSPITAL', message: 'No hospital associated with your account.' }); return; }
    const result = await AdminService.updateMyHospital(user.hospital_id, req.body);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.get('/my-hospital/staff',
  requirePermission(Permission.STAFF_MANAGE),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    if (!user.hospital_id) { sendError(res, 400, { code: 'NO_HOSPITAL', message: 'No hospital associated with your account.' }); return; }
    const result = await AdminService.listHospitalStaff(user.hospital_id, page(req), perPg(req));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

// ══════════════════════════════════════════════════════════════════════════════
//  SUPER_ADMIN only below this line
// ══════════════════════════════════════════════════════════════════════════════

// Per-doctor analytics
router.get('/doctors/:id/stats',
  requirePermission(Permission.DOCTORS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.getDoctorStats(param(req, 'id'));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Switch primary hospital for a multi-affiliated doctor
router.put('/doctors/:id/primary-hospital',
  requirePermission(Permission.DOCTORS_MANAGE),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({ hospital_id: z.string().uuid() }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { hospital_id } = req.body as { hospital_id: string };
    const result = await AdminService.setPrimaryHospital(param(req, 'id'), hospital_id, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Toggle doctor discoverability in patient-facing search
router.patch('/doctors/:id/discovery',
  requirePermission(Permission.DOCTORS_MANAGE),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({ is_discoverable: z.boolean() }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const { is_discoverable } = req.body as { is_discoverable: boolean };
    const { DoctorProfile: DoctorProfileModel } = await import('../../models');
    const doctor = await DoctorProfileModel.findByPk(param(req, 'id'));
    if (!doctor) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Doctor not found.' }); return; }
    await doctor.update({ is_discoverable });
    sendSuccess(res, { id: doctor.id, is_discoverable: doctor.is_discoverable });
  }),
);

// Doctor management
router.patch('/doctors/:id/status',
  requirePermission(Permission.DOCTORS_MANAGE),
  validate(ToggleDoctorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user   = req.user as JwtAccessPayload;
    const { action } = req.body as { action: 'suspend' | 'reactivate' };
    const result = await AdminService.toggleDoctorStatus(param(req, 'id'), action, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.patch('/doctors/:id/verify',
  requirePermission(Permission.DOCTORS_VERIFY),
  validate(VerifyDoctorSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { action, notes } = req.body as { action: 'approve' | 'reject'; notes?: string };
    const result = await AdminService.verifyDoctor(param(req, 'id'), action, user.sub, notes);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Hospital management
router.get('/hospitals',
  requirePermission(Permission.HOSPITALS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.listHospitals({
      onboarding_status: qs(req, 'status') || undefined,
      city:              qs(req, 'city')   || undefined,
      page:    page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

router.get('/hospitals/:id',
  requirePermission(Permission.HOSPITALS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.getHospitalDetail(param(req, 'id'));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.patch('/hospitals/:id',
  requirePermission(Permission.HOSPITALS_MANAGE),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      name:             z.string().trim().min(2).max(200).optional(),
      legal_name:       z.string().trim().max(200).nullable().optional(),
      registration_number: z.string().trim().max(100).nullable().optional(),
      hospital_type:    z.enum(['clinic','nursing_home','hospital','diagnostic_center']).optional(),
      phone_primary:    z.string().trim().max(20).nullable().optional(),
      phone_secondary:  z.string().trim().max(20).nullable().optional(),
      email_general:    z.string().email().nullable().optional(),
      website:          z.string().url().nullable().optional(),
      gst_number:       z.string().trim().max(20).nullable().optional(),
      established_year: z.number().int().min(1800).max(new Date().getFullYear()).nullable().optional(),
      bed_count:        z.number().int().min(0).nullable().optional(),
      address_line1:    z.string().trim().max(300).nullable().optional(),
      address_line2:    z.string().trim().max(300).nullable().optional(),
      city:             z.string().trim().min(2).max(100).optional(),
      state:            z.string().trim().min(2).max(100).optional(),
      pincode:          z.string().trim().max(10).nullable().optional(),
      latitude:         z.number().min(-90).max(90).nullable().optional(),
      longitude:        z.number().min(-180).max(180).nullable().optional(),
    }).strict(),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const { Hospital } = await import('../../models');
    const hospital = await Hospital.findByPk(param(req, 'id'));
    if (!hospital) { sendError(res, 404, { code: 'HOSPITAL_NOT_FOUND', message: 'Hospital not found.' }); return; }
    await hospital.update(req.body);
    sendSuccess(res, hospital);
  }),
);

router.patch('/hospitals/:id/status',
  requirePermission(Permission.HOSPITALS_MANAGE),
  validate(ToggleHospitalSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { action, reason } = req.body as { action: 'suspend' | 'activate'; reason?: string };
    const result = await AdminService.updateHospitalStatus(param(req, 'id'), action, user.sub, reason);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.post('/hospitals/:id/resend-invite',
  requirePermission(Permission.HOSPITALS_MANAGE),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { sendHospitalInvite } = await import('../hospitals/hospital.service');
    const result = await sendHospitalInvite(param(req, 'id'));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.get('/hospitals/:id/staff',
  requirePermission(Permission.STAFF_MANAGE),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.listHospitalStaff(param(req, 'id'), page(req), perPg(req));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

// Patient management
router.get('/patients',
  requirePermission(Permission.PATIENTS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.listPatients({
      account_status: qs(req, 'status') || undefined,
      page:    page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

router.patch('/patients/:id/status',
  requirePermission(Permission.PATIENTS_MANAGE),
  validate(TogglePatientSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { action } = req.body as { action: 'suspend' | 'activate' };
    const result = await AdminService.updatePatientStatus(param(req, 'id'), action, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Pending approval count — badge indicator for sidebar nav
router.get('/pending-approvals',
  requirePermission(Permission.APPOINTMENTS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const scopeId = scopedHospitalId(req);
    const result  = await AdminService.listPendingApprovals({
      hospital_id:     scopeId ?? (qs(req, 'hospital_id') || undefined),
      search:          qs(req, 'search') || qs(req, 'q') || undefined,
      date:            qs(req, 'date') || undefined,
      payment_status:  qs(req, 'payment_status') || qs(req, 'payment') || undefined,
      stale_only:      boolQs(req, 'stale_only') || boolQs(req, 'stale'),
      page:            page(req),
      perPage:         perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

router.get('/pending-approvals/count',
  requirePermission(Permission.APPOINTMENTS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const { Appointment, AppointmentStatus: ApptStatus } = await import('../../models');
    const scopeId = scopedHospitalId(req);
    const where: Record<string, unknown> = { status: ApptStatus.AWAITING_HOSPITAL_APPROVAL };
    if (scopeId) where.hospital_id = scopeId;
    const count = await Appointment.count({ where });
    sendSuccess(res, { count });
  }),
);

// Waitlist admin — list entries with patient details scoped by hospital
router.get('/waitlist',
  requirePermission(Permission.APPOINTMENTS_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const { WaitlistEntry, DoctorProfile, User, PatientProfile } = await import('../../models');
    const scopeId = scopedHospitalId(req);
    if (!scopeId) { sendError(res, 400, { code: 'NO_HOSPITAL', message: 'hospital_id is required.' }); return; }

    const date     = qs(req, 'date') || undefined;
    const doctorId = qs(req, 'doctor_id') || undefined;
    const status   = qs(req, 'status') || undefined;

    const where: Record<string, unknown> = { hospital_id: scopeId };
    if (date)     where.date      = date;
    if (doctorId) where.doctor_id = doctorId;
    if (status)   where.status    = status;

    const entries = await WaitlistEntry.findAll({
      where,
      order: [['position', 'ASC'], ['created_at', 'ASC']],
      include: [
        { model: DoctorProfile, as: 'doctor',  attributes: ['id', 'full_name', 'specialization'], required: false },
        {
          model: User, as: 'patient', attributes: ['id', 'mobile'], required: false,
          include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'], required: false }],
        },
      ],
    });

    const result = entries.map((e) => {
      const doc     = e.get('doctor')  as DoctorProfile | null;
      const patient = e.get('patient') as (User & { patientProfile?: PatientProfile }) | null;
      const profile = patient?.get('patientProfile') as PatientProfile | null;
      return {
        id:               e.id,
        position:         e.position,
        status:           e.status,
        date:             e.date,
        offered_at:       e.offered_at,
        expires_at:       e.expires_at,
        created_at:       e.created_at,
        doctor:    doc    ? { id: doc.id,         full_name: doc.full_name, specialization: doc.specialization } : null,
        patient:   patient ? { id: patient.id,     mobile: patient.mobile, full_name: profile?.full_name ?? null } : null,
      };
    });

    sendSuccess(res, result, 200, { total: result.length, page: 1, per_page: result.length, total_pages: 1 });
  }),
);

// Remove a waitlist entry (admin action)
router.delete('/waitlist/:id',
  requirePermission(Permission.APPOINTMENTS_READ),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { WaitlistEntry, WaitlistStatus: WStatus } = await import('../../models');
    const entry = await WaitlistEntry.findByPk(param(req, 'id'));
    if (!entry) { sendError(res, 404, { code: 'NOT_FOUND', message: 'Waitlist entry not found.' }); return; }

    const scopeId = scopedHospitalId(req);
    if (scopeId && entry.hospital_id !== scopeId) {
      sendError(res, 403, { code: 'FORBIDDEN', message: 'Access denied.' }); return;
    }

    if (entry.status === WStatus.OFFERED && entry.offered_slot_id) {
      const { OpdSlotSession, OpdSlotStatus } = await import('../../models');
      await OpdSlotSession.update({ status: OpdSlotStatus.PUBLISHED }, { where: { id: entry.offered_slot_id } });
    }

    await entry.update({ status: WStatus.CANCELLED });
    sendSuccess(res, { message: 'Waitlist entry removed.' });
  }),
);

// Audit logs
router.get('/audit-logs',
  requirePermission(Permission.AUDIT_READ),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await AdminService.getAuditLogs({
      admin_id:      qs(req, 'admin_id')      || undefined,
      resource_type: qs(req, 'resource_type') || undefined,
      action:        qs(req, 'action')        || undefined,
      page:    page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
  }),
);

// Reliability score recompute
router.post('/reliability/recompute',
  requirePermission(Permission.DOCTORS_MANAGE),
  asyncHandler(async (_req: Request, res: Response) => {
    const result = await AdminService.computeReliabilityScores();
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
