import { Router, Request, Response }     from 'express';
import * as AdminService                  from './admin.service';
import { authenticate, requireRole }      from '../../middlewares/auth.middleware';
import { requirePermission, scopedHospitalId, Permission } from '../../middlewares/permission.middleware';
import { validate }                       from '../../middlewares/validate.middleware';
import { sendSuccess, sendError }         from '../../utils/response';
import { JwtAccessPayload, UserRole }     from '../../types';
import { asyncHandler }                   from '../../utils/asyncHandler';
import { z }                              from 'zod';

const param = (req: Request, k: string) => String((req.params as Record<string, string>)[k] ?? '');
const qs    = (req: Request, k: string, d = '') => String((req.query  as Record<string, string>)[k] ?? d);
const page  = (req: Request) => Math.max(1, parseInt(qs(req, 'page', '1'), 10));
const perPg = (req: Request) => Math.min(100, Math.max(1, parseInt(qs(req, 'per_page', '20'), 10)));

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

// Revenue time-series for chart
router.get('/financial/chart',
  requirePermission(Permission.FINANCIALS_READ),
  validate(PeriodSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const period = qs(req, 'period', 'week') as 'today' | 'week' | 'month';
    const result = await AdminService.getRevenueTimeSeries(period);
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
      hospital_id:         scopeId,
      verification_status: qs(req, 'verification_status') || undefined,
      page:  page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
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
      page:  page(req),
      perPage: perPg(req),
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page: page(req), per_page: perPg(req), total_pages: Math.ceil(d.count / perPg(req)) });
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
      scopedHospitalId(req),
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
