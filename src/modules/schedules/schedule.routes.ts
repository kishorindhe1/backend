import { Router, Request, Response } from 'express';
import * as ScheduleService  from './schedule.service';
import { authenticate }       from '../../middlewares/auth.middleware';
import { requireRole }        from '../../middlewares/auth.middleware';
import { validate }           from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }           from '../../types';
import { asyncHandler }       from '../../utils/asyncHandler';
import { z }                  from 'zod';

// ── Validation ────────────────────────────────────────────────────────────────
const GetSlotsSchema = z.object({
  params: z.object({
    doctorId:   z.string().uuid(),
    hospitalId: z.string().uuid(),
  }),
  query: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD'),
  }),
});

const GenerateSlotsSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid(),
    hospital_id: z.string().uuid(),
    days_ahead:  z.number().int().min(1).max(60).optional(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function deactivateSchedule(req: Request, res: Response): Promise<void> {
  const { scheduleId } = req.params as { scheduleId: string };
  const result = await ScheduleService.deactivateSchedule(scheduleId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getSchedules(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const result = await ScheduleService.listSchedules(doctorId, hospitalId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getAvailableSlots(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const { date } = req.query as { date: string };

  const result = await ScheduleService.getAvailableSlots(doctorId, hospitalId, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function triggerSlotGeneration(req: Request, res: Response): Promise<void> {
  const { doctor_id, hospital_id, days_ahead } = req.body as {
    doctor_id: string; hospital_id: string; days_ahead?: number;
  };
  const result = await ScheduleService.generateSlotsForDoctor(doctor_id, hospital_id, days_ahead);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// Protected — staff list schedules for a doctor
router.get(
  '/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  asyncHandler(getSchedules),
);

// Public — patients browse slots
router.get(
  '/:doctorId/:hospitalId/slots',
  validate(GetSlotsSchema),
  asyncHandler(getAvailableSlots),
);

// Protected — deactivate a schedule
router.patch(
  '/:scheduleId/deactivate',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  asyncHandler(deactivateSchedule),
);

// Protected — hospital admin / super admin trigger slot generation
router.post(
  '/generate',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(GenerateSlotsSchema),
  asyncHandler(triggerSlotGeneration),
);

export default router;
