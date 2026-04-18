import { Router, Request, Response } from 'express';
import * as GapBookingService          from './gap-booking.service';
import { authenticate, requireRole }   from '../../middlewares/auth.middleware';
import { validate }                    from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }                    from '../../types';
import { asyncHandler }                from '../../utils/asyncHandler';
import { z }                           from 'zod';
import { ProcedureCategory }           from '../../models';

// ── Validation schemas ────────────────────────────────────────────────────────
const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

const CreateProcedureTypeSchema = z.object({
  body: z.object({
    doctor_id:            z.string().uuid(),
    hospital_id:          z.string().uuid(),
    name:                 z.string().min(2).max(100),
    duration_minutes:     z.number().int().min(5).max(480),
    category:             z.nativeEnum(ProcedureCategory).optional(),
    prep_time_minutes:    z.number().int().min(0).max(120).optional(),
    cleanup_time_minutes: z.number().int().min(0).max(120).optional(),
    color_code:           z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }),
});

const UpdateProcedureTypeSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name:                 z.string().min(2).max(100).optional(),
    duration_minutes:     z.number().int().min(5).max(480).optional(),
    prep_time_minutes:    z.number().int().min(0).max(120).optional(),
    cleanup_time_minutes: z.number().int().min(0).max(120).optional(),
    color_code:           z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
    is_active:            z.boolean().optional(),
  }),
});

const FindGapsSchema = z.object({
  params: z.object({
    doctorId:         z.string().uuid(),
    hospitalId:       z.string().uuid(),
    procedureTypeId:  z.string().uuid(),
  }),
  query: z.object({
    date:         z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
    step_minutes: z.coerce.number().int().min(5).max(60).optional(),
  }),
});

const ListProcedureTypesSchema = z.object({
  params: z.object({
    doctorId:   z.string().uuid(),
    hospitalId: z.string().uuid(),
  }),
});

const BookGapSchema = z.object({
  body: z.object({
    doctor_id:         z.string().uuid(),
    hospital_id:       z.string().uuid(),
    date:              z.string().regex(dateRegex, 'date must be YYYY-MM-DD'),
    procedure_type_id: z.string().uuid(),
    start_time:        z.string().regex(timeRegex, 'start_time must be HH:MM'),
    notes:             z.string().max(500).optional(),
    payment_mode:      z.enum(['cash', 'card', 'online_prepaid']).optional(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function listProcedureTypes(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const result = await GapBookingService.listProcedureTypes(doctorId, hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function createProcedureType(req: Request, res: Response): Promise<void> {
  const result = await GapBookingService.createProcedureType(req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function updateProcedureType(req: Request, res: Response): Promise<void> {
  const { id } = req.params as { id: string };
  const result = await GapBookingService.updateProcedureType(id, req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function findGaps(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId, procedureTypeId } = req.params as {
    doctorId: string; hospitalId: string; procedureTypeId: string;
  };
  const { date, step_minutes } = req.query as { date: string; step_minutes?: string };
  const result = await GapBookingService.findAvailableGaps(doctorId, hospitalId, date, procedureTypeId, step_minutes ? parseInt(step_minutes, 10) : 15);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function bookGap(req: Request, res: Response): Promise<void> {
  const patientId = (req as any).user.sub as string;
  const body = req.body as {
    doctor_id: string; hospital_id: string; date: string;
    procedure_type_id: string; start_time: string; notes?: string; payment_mode?: any;
  };
  const result = await GapBookingService.bookGap({ ...body, patient_id: patientId });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// List procedure types (public — patients need to see them to book)
router.get(
  '/:doctorId/:hospitalId',
  validate(ListProcedureTypesSchema),
  asyncHandler(listProcedureTypes),
);

// Create procedure type — hospital admin / super admin
router.post(
  '/',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(CreateProcedureTypeSchema),
  asyncHandler(createProcedureType),
);

// Update procedure type
router.patch(
  '/:id',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(UpdateProcedureTypeSchema),
  asyncHandler(updateProcedureType),
);

// Find available gaps for a procedure
router.get(
  '/:doctorId/:hospitalId/:procedureTypeId/gaps',
  validate(FindGapsSchema),
  asyncHandler(findGaps),
);

// Book a gap — authenticated patient
router.post(
  '/book',
  authenticate,
  validate(BookGapSchema),
  asyncHandler(bookGap),
);

export default router;
