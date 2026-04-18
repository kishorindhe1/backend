import { Router, Request, Response } from 'express';
import * as WaitlistService           from './waitlist.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

const JoinSchema = z.object({
  body: z.object({
    doctor_id:             z.string().uuid(),
    hospital_id:           z.string().uuid(),
    date:                  z.string().regex(dateRegex),
    procedure_type_id:     z.string().uuid().optional(),
    preferred_start_time:  z.string().regex(timeRegex).optional(),
    preferred_end_time:    z.string().regex(timeRegex).optional(),
  }),
});

const ConfirmSchema = z.object({
  params: z.object({ entryId: z.string().uuid() }),
});

const GetWaitlistSchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  query:  z.object({ date: z.string().regex(dateRegex) }),
});

const NoShowSchema = z.object({
  params: z.object({ appointmentId: z.string().uuid() }),
  body:   z.object({ grace_period_minutes: z.number().int().min(0).max(60).optional() }),
});

async function join(req: Request, res: Response): Promise<void> {
  const patientId = (req as any).user.sub as string;
  const { doctor_id, hospital_id, date, procedure_type_id, preferred_start_time, preferred_end_time } = req.body as any;
  const result = await WaitlistService.joinWaitlist(patientId, doctor_id, hospital_id, date, procedure_type_id, preferred_start_time, preferred_end_time);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function confirm(req: Request, res: Response): Promise<void> {
  const patientId = (req as any).user.sub as string;
  const { entryId } = req.params as { entryId: string };
  const result = await WaitlistService.confirmWaitlistOffer(entryId, patientId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function cancel(req: Request, res: Response): Promise<void> {
  const patientId = (req as any).user.sub as string;
  const { entryId } = req.params as { entryId: string };
  const result = await WaitlistService.cancelWaitlistEntry(entryId, patientId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getWaitlist(req: Request, res: Response): Promise<void> {
  const { doctorId, hospitalId } = req.params as { doctorId: string; hospitalId: string };
  const { date } = req.query as { date: string };
  const result = await WaitlistService.getWaitlist(doctorId, hospitalId, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function markNoShow(req: Request, res: Response): Promise<void> {
  const { appointmentId } = req.params as { appointmentId: string };
  const markedBy = (req as any).user.sub as string;
  const { grace_period_minutes } = req.body as { grace_period_minutes?: number };
  const result = await WaitlistService.markNoShow(appointmentId, markedBy, grace_period_minutes);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

const router = Router();

// Patient views their own waitlist entries
router.get(
  '/my',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const patientId = (req as any).user.sub as string;
    const result = await WaitlistService.getMyWaitlist(patientId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Patient joins waitlist
router.post(
  '/join',
  authenticate,
  validate(JoinSchema),
  asyncHandler(join),
);

// Patient confirms a slot offer
router.post(
  '/confirm/:entryId',
  authenticate,
  validate(ConfirmSchema),
  asyncHandler(confirm),
);

// Patient cancels their waitlist spot
router.delete(
  '/:entryId',
  authenticate,
  asyncHandler(cancel),
);

// Staff views waitlist for a doctor/date
router.get(
  '/:doctorId/:hospitalId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(GetWaitlistSchema),
  asyncHandler(getWaitlist),
);

// Receptionist marks patient as no-show
router.post(
  '/no-show/:appointmentId',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(NoShowSchema),
  asyncHandler(markNoShow),
);

export default router;
