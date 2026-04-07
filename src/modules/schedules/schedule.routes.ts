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

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const GenerateSlotsSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid(),
    hospital_id: z.string().uuid(),
    from_date:   z.string().regex(dateRegex, 'from_date must be YYYY-MM-DD'),
    to_date:     z.string().regex(dateRegex, 'to_date must be YYYY-MM-DD'),
  }),
});

const BlockSlotSchema = z.object({
  params: z.object({ slotId: z.string().uuid() }),
  body:   z.object({ reason: z.string().min(1).max(200) }),
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
  const { doctor_id, hospital_id, from_date, to_date } = req.body as {
    doctor_id: string; hospital_id: string; from_date: string; to_date: string;
  };
  const result = await ScheduleService.generateSlotsForDoctor(doctor_id, hospital_id, from_date, to_date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function blockSlotHandler(req: Request, res: Response): Promise<void> {
  const { slotId } = req.params as { slotId: string };
  const { reason } = req.body as { reason: string };
  const result = await ScheduleService.blockSlot(slotId, reason);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function unblockSlotHandler(req: Request, res: Response): Promise<void> {
  const { slotId } = req.params as { slotId: string };
  const result = await ScheduleService.unblockSlot(slotId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
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

// Block / unblock a slot (admin)
router.patch(
  '/slots/:slotId/block',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(BlockSlotSchema),
  asyncHandler(blockSlotHandler),
);

router.patch(
  '/slots/:slotId/unblock',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  asyncHandler(unblockSlotHandler),
);

export default router;
