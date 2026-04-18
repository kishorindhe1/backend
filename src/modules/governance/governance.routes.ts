import { Router, Request, Response } from 'express';
import * as GovernanceService              from './governance.service';
import * as ChangeManagementService        from './change-management.service';
import * as TemplatesService               from './templates.service';
import * as AnalyticsService               from '../analytics/analytics.service';
import * as DoctorCustomizationService     from './doctor-customization.service';
import { SlotAutonomyLevel }               from '../../models';
import { issueWalkInToken }                from '../receptionist/receptionist.service';
import { OverrideType }                   from '../../models';
import { SlotChangeScope }                from '../../models';
import { authenticate, requireRole }      from '../../middlewares/auth.middleware';
import { validate }                       from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }                       from '../../types';
import { asyncHandler }                   from '../../utils/asyncHandler';
import { z }                              from 'zod';

// ── Validation ────────────────────────────────────────────────────────────────
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

const DraftSchema = z.object({
  body: z.object({
    hospital_id: z.string().uuid(),
    date:        z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
  }),
});

const PublishSchema = z.object({
  body: z.object({
    hospital_id: z.string().uuid(),
    date:        z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
  }),
});

const GetDraftsSchema = z.object({
  params: z.object({
    hospitalId: z.string().uuid(),
    date:       z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
  }),
});

const GetPublishedSchema = z.object({
  params: z.object({
    doctorId:   z.string().uuid(),
    hospitalId: z.string().uuid(),
  }),
  query: z.object({
    date: z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
  }),
});

const ApplyOverrideSchema = z.object({
  body: z.object({
    doctor_id:     z.string().uuid(),
    hospital_id:   z.string().uuid(),
    date:          z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
    override_type: z.nativeEnum(OverrideType),
    start_time:    z.string().regex(timeRegex, 'start_time must be HH:MM').optional(),
    end_time:      z.string().regex(timeRegex, 'end_time must be HH:MM').optional(),
    delay_minutes: z.number().int().min(1).max(180).optional(),
    reason:        z.string().max(300).optional(),
    scope:         z.nativeEnum(SlotChangeScope),
  }),
});

const RollbackSchema = z.object({
  params: z.object({
    changeLogId: z.string().uuid(),
  }),
});

const GetChangeLogsSchema = z.object({
  params: z.object({
    hospitalId: z.string().uuid(),
  }),
  query: z.object({
    doctor_id: z.string().uuid().optional(),
    date:      z.string().regex(dateRegex).optional(),
  }),
});

const TodayOPDSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
});

const WalkInTokenSchema = z.object({
  body: z.object({
    doctor_id:    z.string().uuid(),
    hospital_id:  z.string().uuid(),
    patient_id:   z.string().uuid().optional(),
    patient_name: z.string().max(100).optional(),
  }).refine((b) => b.patient_id || b.patient_name, {
    message: 'Either patient_id or patient_name is required',
  }),
});

const GetPreferencesSchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
});

const UpsertPreferencesSchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  body: z.object({
    min_booking_lead_hours:     z.number().int().min(0).max(72).optional(),
    booking_cutoff_hours:       z.number().int().min(0).max(72).optional(),
    max_new_patients_per_day:   z.number().int().min(1).max(200).nullable().optional(),
    max_followups_per_day:      z.number().int().min(1).max(200).nullable().optional(),
    new_patient_slot_positions: z.array(z.number().int().min(1)).nullable().optional(),
    followup_slot_positions:    z.array(z.number().int().min(1)).nullable().optional(),
    requires_booking_approval:  z.boolean().optional(),
    approval_timeout_hours:     z.number().int().min(1).max(72).optional(),
    default_slot_duration:      z.number().int().min(5).max(120).nullable().optional(),
    notes_for_patients:         z.string().max(500).nullable().optional(),
  }),
});

const UpdateAutonomySchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  body: z.object({
    slot_autonomy_level: z.nativeEnum(SlotAutonomyLevel),
  }),
});

const ListTemplatesSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
});

const CreateTemplateSchema = z.object({
  body: z.object({
    hospital_id:              z.string().uuid(),
    name:                     z.string().min(1).max(100),
    applies_to:               z.enum(['ALL_DOCTORS', 'SPECIFIC_DOCTORS', 'BY_SPECIALISATION']),
    doctor_ids:               z.array(z.string().uuid()).optional(),
    specialisation:           z.string().optional(),
    day_of_week:              z.string().optional(),
    override_start_time:      z.string().regex(timeRegex).optional(),
    override_end_time:        z.string().regex(timeRegex).optional(),
    capacity_percent:         z.number().int().min(1).max(100).optional(),
    emergency_reserve_slots:  z.number().int().min(0).max(20).optional(),
    notes:                    z.string().max(500).optional(),
  }),
});

const DeleteTemplateSchema = z.object({
  params: z.object({ templateId: z.string().uuid(), hospitalId: z.string().uuid() }),
});

const ApplyTemplateSchema = z.object({
  params: z.object({ templateId: z.string().uuid(), hospitalId: z.string().uuid() }),
  body: z.object({
    date: z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
  }),
});

const GetStatsSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
  query: z.object({
    from:      z.string().regex(dateRegex),
    to:        z.string().regex(dateRegex),
    doctor_id: z.string().uuid().optional(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function draftSlots(req: Request, res: Response): Promise<void> {
  const { hospital_id, date } = req.body as { hospital_id: string; date: string };
  const result = await GovernanceService.draftSlotsForDate(hospital_id, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function publishSlots(req: Request, res: Response): Promise<void> {
  const { hospital_id, date } = req.body as { hospital_id: string; date: string };
  const reviewedBy = (req as any).user.sub as string;
  const result = await GovernanceService.publishSlots(hospital_id, date, reviewedBy);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getDraftSlots(req: Request, res: Response): Promise<void> {
  const { hospitalId, date } = req.params as { hospitalId: string; date: string };
  const result = await GovernanceService.getDraftSlots(hospitalId, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getPublishedSlots(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const { date } = req.query as { date: string };
  const result = await GovernanceService.getPublishedSlots(doctorId, hospitalId, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function applyOverride(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    doctor_id: string; hospital_id: string; date: string;
    override_type: OverrideType; start_time?: string; end_time?: string;
    delay_minutes?: number; reason?: string; scope: SlotChangeScope;
  };
  const createdBy = (req as any).user.sub as string;

  const result = await ChangeManagementService.applyOverride({
    doctorId:      body.doctor_id,
    hospitalId:    body.hospital_id,
    date:          body.date,
    overrideType:  body.override_type,
    startTime:     body.start_time,
    endTime:       body.end_time,
    delayMinutes:  body.delay_minutes,
    reason:        body.reason,
    createdBy,
    scope:         body.scope,
  });

  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function rollbackChange(req: Request, res: Response): Promise<void> {
  const { changeLogId } = req.params as { changeLogId: string };
  const rolledBackBy = (req as any).user.sub as string;
  const result = await ChangeManagementService.rollbackChange(changeLogId, rolledBackBy);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getChangeLogs(req: Request, res: Response): Promise<void> {
  const { hospitalId } = req.params as { hospitalId: string };
  const { doctor_id, date } = req.query as { doctor_id?: string; date?: string };
  const result = await ChangeManagementService.getChangeLogs(hospitalId, doctor_id, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getTodayOPD(req: Request, res: Response): Promise<void> {
  const { hospitalId } = req.params as { hospitalId: string };
  const result = await GovernanceService.getTodayOPD(hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function issueWalkInTokenHandler(req: Request, res: Response): Promise<void> {
  const { doctor_id, hospital_id, patient_id, patient_name } = req.body as {
    doctor_id: string; hospital_id: string; patient_id?: string; patient_name?: string;
  };
  const created_by = (req as any).user.sub as string;
  const result = await issueWalkInToken({ doctor_id, hospital_id, patient_id, patient_name, created_by });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function getPreferences(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const result = await DoctorCustomizationService.getPreferences(doctorId, hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function upsertPreferences(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const result = await DoctorCustomizationService.upsertPreferences(doctorId, hospitalId, req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function updateAutonomy(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const { slot_autonomy_level } = req.body as { slot_autonomy_level: SlotAutonomyLevel };
  const result = await DoctorCustomizationService.updateAutonomyLevel(doctorId, hospitalId, slot_autonomy_level);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function listTemplates(req: Request, res: Response): Promise<void> {
  const { hospitalId } = req.params as { hospitalId: string };
  const result = await TemplatesService.listTemplates(hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function createTemplate(req: Request, res: Response): Promise<void> {
  const body = req.body as any;
  const created_by = (req as any).user.sub as string;
  const result = await TemplatesService.createTemplate({ ...body, created_by });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function deleteTemplate(req: Request, res: Response): Promise<void> {
  const { templateId, hospitalId } = req.params as { templateId: string; hospitalId: string };
  const result = await TemplatesService.deleteTemplate(templateId, hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function applyTemplate(req: Request, res: Response): Promise<void> {
  const { templateId, hospitalId } = req.params as { templateId: string; hospitalId: string };
  const { date } = req.body as { date: string };
  const appliedBy = (req as any).user.sub as string;
  const result = await TemplatesService.applyTemplate(templateId, hospitalId, date, appliedBy);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getStats(req: Request, res: Response): Promise<void> {
  const { hospitalId } = req.params as { hospitalId: string };
  const { from, to, doctor_id } = req.query as { from: string; to: string; doctor_id?: string };
  const result = await AnalyticsService.getHospitalStats(hospitalId, from, to, doctor_id);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// Draft slots for a hospital date — hospital_admin + receptionist
router.post(
  '/draft',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(DraftSchema),
  asyncHandler(draftSlots),
);

// Publish draft slots — hospital_admin + receptionist
router.post(
  '/publish',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(PublishSchema),
  asyncHandler(publishSlots),
);

// Apply a doctor availability override — receptionist + hospital_admin
router.post(
  '/override',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(ApplyOverrideSchema),
  asyncHandler(applyOverride),
);

// Rollback a change log entry — hospital_admin + super_admin only
router.post(
  '/rollback/:changeLogId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(RollbackSchema),
  asyncHandler(rollbackChange),
);

// Get change logs for a hospital
router.get(
  '/changes/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(GetChangeLogsSchema),
  asyncHandler(getChangeLogs),
);

// Get draft slots for review screen
router.get(
  '/drafts/:hospitalId/:date',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(GetDraftsSchema),
  asyncHandler(getDraftSlots),
);

// Today's live OPD dashboard
router.get(
  '/today/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(TodayOPDSchema),
  asyncHandler(getTodayOPD),
);

// Issue walk-in token (governance-linked)
router.post(
  '/walk-in-token',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(WalkInTokenSchema),
  asyncHandler(issueWalkInTokenHandler),
);

// Doctor booking preferences
router.get(
  '/preferences/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(GetPreferencesSchema),
  asyncHandler(getPreferences),
);

router.put(
  '/preferences/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(UpsertPreferencesSchema),
  asyncHandler(upsertPreferences),
);

// Slot autonomy level
router.get(
  '/autonomy/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(GetPreferencesSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
    const result = await DoctorCustomizationService.getAutonomyLevel(doctorId, hospitalId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.patch(
  '/autonomy/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(UpdateAutonomySchema),
  asyncHandler(updateAutonomy),
);

// Templates — hospital_admin + super_admin
router.get(
  '/templates/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(ListTemplatesSchema),
  asyncHandler(listTemplates),
);

router.post(
  '/templates',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(CreateTemplateSchema),
  asyncHandler(createTemplate),
);

router.delete(
  '/templates/:templateId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(DeleteTemplateSchema),
  asyncHandler(deleteTemplate),
);

router.post(
  '/templates/:templateId/:hospitalId/apply',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(ApplyTemplateSchema),
  asyncHandler(applyTemplate),
);

// Analytics stats
router.get(
  '/stats/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(GetStatsSchema),
  asyncHandler(getStats),
);

const ReportDateSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
  query:  z.object({ from: z.string().regex(dateRegex), to: z.string().regex(dateRegex) }),
});

router.get(
  '/stats/:hospitalId/punctuality',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(ReportDateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { hospitalId } = req.params as { hospitalId: string };
    const { from, to } = req.query as { from: string; to: string };
    const result = await AnalyticsService.getPunctualityReport(hospitalId, from, to);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.get(
  '/stats/:hospitalId/utilisation-trend',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(ReportDateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { hospitalId } = req.params as { hospitalId: string };
    const { from, to } = req.query as { from: string; to: string };
    const result = await AnalyticsService.getUtilisationTrend(hospitalId, from, to);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.get(
  '/stats/:hospitalId/gap-efficiency',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(ReportDateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { hospitalId } = req.params as { hospitalId: string };
    const { from, to } = req.query as { from: string; to: string };
    const result = await AnalyticsService.getGapEfficiencyReport(hospitalId, from, to);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Get published slots for a doctor on a date (public — patients browse)
router.get(
  '/published/:doctorId/:hospitalId',
  validate(GetPublishedSchema),
  asyncHandler(getPublishedSlots),
);

export default router;
