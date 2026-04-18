import { Router, Request, Response } from 'express';
import * as DoctorAppService          from './doctor-app.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^\d{2}:\d{2}$/;

// ── Validation ────────────────────────────────────────────────────────────────

const ApptIdSchema = z.object({ params: z.object({ appointmentId: z.string().uuid() }) });

const SelfDelaySchema = z.object({
  body: z.object({
    hospital_id:   z.string().uuid(),
    delay_minutes: z.number().int().min(1).max(480),
    reason:        z.string().max(300).optional(),
  }),
});

const SelfCheckInSchema = z.object({
  body: z.object({ hospital_id: z.string().uuid() }),
});

const GetQueueSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
  query:  z.object({ date: z.string().regex(dateRegex).optional() }),
});

const ReserveFollowUpSchema = z.object({
  body: z.object({
    hospital_id:    z.string().uuid(),
    patient_id:     z.string().uuid(),
    date:           z.string().regex(dateRegex),
    preferred_time: z.string().regex(timeRegex).optional(),
  }),
});

const TimelineSchema = z.object({
  params: z.object({ hospitalId: z.string().uuid() }),
  query:  z.object({ date: z.string().regex(dateRegex).optional() }),
});

// ── Router ────────────────────────────────────────────────────────────────────

const router = Router();
const DOCTOR_ROLES = [UserRole.DOCTOR, UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN];

// Mark consultation done — doctor closes the current consultation
router.patch(
  '/appointments/:appointmentId/done',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(ApptIdSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req as any).user.sub as string;
    const { appointmentId } = req.params as { appointmentId: string };
    const result = await DoctorAppService.markConsultationDone(appointmentId, doctorId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Self-report delay
router.post(
  '/delay',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(SelfDelaySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req as any).user.sub as string;
    const { hospital_id, delay_minutes, reason } = req.body as { hospital_id: string; delay_minutes: number; reason?: string };
    const result = await DoctorAppService.selfReportDelay(doctorId, hospital_id, delay_minutes, reason);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Self check-in (resolve own delay)
router.post(
  '/check-in',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(SelfCheckInSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req as any).user.sub as string;
    const { hospital_id } = req.body as { hospital_id: string };
    const result = await DoctorAppService.selfCheckIn(doctorId, hospital_id);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Get own queue for a hospital/date
router.get(
  '/queue/:hospitalId',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(GetQueueSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId   = (req as any).user.sub as string;
    const hospitalId = (req.params as any).hospitalId as string;
    const date = (req.query as any).date as string ?? new Date().toISOString().split('T')[0];
    const result = await DoctorAppService.getDoctorOwnQueue(doctorId, hospitalId, date);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Reserve follow-up slot for a patient
router.post(
  '/follow-up',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(ReserveFollowUpSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req as any).user.sub as string;
    const body = req.body as { hospital_id: string; patient_id: string; date: string; preferred_time?: string };
    const result = await DoctorAppService.reserveFollowUpSlot({
      doctorId,
      hospitalId:    body.hospital_id,
      patientId:     body.patient_id,
      date:          body.date,
      preferredTime: body.preferred_time,
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendCreated(res, result.data);
  }),
);

// Gap-based timeline view for the day
router.get(
  '/timeline/:hospitalId',
  authenticate,
  requireRole(...DOCTOR_ROLES),
  validate(TimelineSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId   = (req as any).user.sub as string;
    const hospitalId = (req.params as any).hospitalId as string;
    const date = (req.query as any).date as string ?? new Date().toISOString().split('T')[0];
    const result = await DoctorAppService.getGapTimeline(doctorId, hospitalId, date);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
