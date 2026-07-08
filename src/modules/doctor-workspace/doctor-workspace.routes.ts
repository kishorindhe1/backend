import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as DoctorWorkspaceService from './doctor-workspace.service';
import { authenticate, requireRole } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendError, sendSuccess } from '../../utils/response';
import { UserRole } from '../../types';
import { istDate } from '../../utils/dateTime';

const router = Router();
router.use(authenticate, requireRole(UserRole.DOCTOR));

const ApptSchema = z.object({ params: z.object({ appointmentId: z.string().uuid() }) });
const DelaySchema = z.object({
  body: z.object({
    delay_minutes: z.number().int().min(1).max(480),
    reason: z.string().max(300).optional(),
  }),
});
const AvailabilityRequestSchema = z.object({
  body: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    change_type: z.enum(['day_off', 'late_start', 'early_end', 'break', 'running_late']),
    start_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    end_time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    delay_minutes: z.number().int().min(1).max(480).optional(),
    reason: z.string().max(300).optional(),
  }),
});
const ProfileSchema = z.object({
  body: z.object({
    bio: z.string().max(1000).optional(),
    languages: z.array(z.string().min(1).max(40)).max(12).optional(),
  }),
});

router.get('/today', asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.getToday(req.user!.sub, String(req.query.date ?? istDate()));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.patch('/appointments/:appointmentId/start', validate(ApptSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.startConsultation(req.user!.sub, req.params.appointmentId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.patch('/appointments/:appointmentId/complete', validate(ApptSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.completeConsultation(req.user!.sub, req.params.appointmentId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.patch('/appointments/:appointmentId/skip', validate(ApptSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.skipAppointment(req.user!.sub, req.params.appointmentId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.post('/delay', validate(DelaySchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.reportDelay(req.user!.sub, req.body as { delay_minutes: number; reason?: string });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.get('/opd/history', asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.getHistory(req.user!.sub, {
    from: req.query.from ? String(req.query.from) : undefined,
    to: req.query.to ? String(req.query.to) : undefined,
  });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.get('/availability', asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.getAvailability(req.user!.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.post('/availability/request-change', validate(AvailabilityRequestSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.requestAvailabilityChange(req.user!.sub, req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.get('/me', asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.getProfile(req.user!.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

router.patch('/me', validate(ProfileSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await DoctorWorkspaceService.updateProfile(req.user!.sub, req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

export default router;
