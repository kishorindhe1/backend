import { Router, Request, Response } from 'express';
import { z }                          from 'zod';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendError, sendCreated } from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import * as DurationService           from './duration.service';

const router = Router();

const SetDurationSchema = z.object({
  body: z.object({
    patient_id:       z.string().uuid(),
    doctor_id:        z.string().uuid(),
    duration_minutes: z.number().int().min(1).max(480),
    notes:            z.string().max(500).optional(),
  }),
});

const GetDurationSchema = z.object({
  params: z.object({
    patientId: z.string().uuid(),
    doctorId:  z.string().uuid(),
  }),
});

const OverrideSchema = z.object({
  body: z.object({
    patient_id:       z.string().uuid(),
    doctor_id:        z.string().uuid(),
    override_minutes: z.number().int().min(1).max(480),
    reason:           z.string().min(1).max(500),
  }),
});

// ── POST /duration/set ────────────────────────────────────────────────────────
// Set or update personalized duration for a patient+doctor pair after consultation.
router.post(
  '/set',
  authenticate,
  requireRole(UserRole.DOCTOR, UserRole.RECEPTIONIST, UserRole.HOSPITAL_ADMIN),
  validate(SetDurationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DurationService.setDuration({
      patient_id:       req.body.patient_id,
      doctor_id:        req.body.doctor_id,
      duration_minutes: req.body.duration_minutes,
      set_by_user_id:   req.user!.sub,
      set_by_role:      req.user!.role === UserRole.DOCTOR ? 'doctor' : 'receptionist',
      notes:            req.body.notes,
    });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendCreated(res, result.data);
  }),
);

// ── GET /duration/:patientId/:doctorId ────────────────────────────────────────
// Get current duration + history for a patient+doctor pair.
router.get(
  '/:patientId/:doctorId',
  authenticate,
  requireRole(UserRole.DOCTOR, UserRole.RECEPTIONIST, UserRole.HOSPITAL_ADMIN),
  validate(GetDurationSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DurationService.getDurationHistory(
      req.params.patientId,
      req.params.doctorId,
    );
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// ── POST /duration/override ───────────────────────────────────────────────────
// Log a one-time visit extension. Does NOT update stored patient_doctor_durations.
router.post(
  '/override',
  authenticate,
  requireRole(UserRole.DOCTOR, UserRole.RECEPTIONIST, UserRole.HOSPITAL_ADMIN),
  validate(OverrideSchema),
  asyncHandler(async (req: Request, res: Response) => {
    await DurationService.recordOneTimeOverride(
      req.body.patient_id,
      req.body.doctor_id,
      req.body.override_minutes,
      req.user!.sub,
      req.user!.role === UserRole.DOCTOR ? 'doctor' : 'receptionist',
      `one_time_override: ${req.body.reason}`,
    );
    sendSuccess(res, { recorded: true });
  }),
);

export default router;
