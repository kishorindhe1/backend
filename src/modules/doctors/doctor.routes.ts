import { Router, Request, Response } from 'express';
import * as DoctorController from './doctor.controller';
import { authenticate, requireRole } from '../../middlewares/auth.middleware';
import { validate }                  from '../../middlewares/validate.middleware';
import { UserRole }                  from '../../types';
import { asyncHandler }              from '../../utils/asyncHandler';
import {
  CreateDoctorSchema,
  CreateScheduleSchema,
  DoctorIdSchema,
} from './doctor.validation';
import { z } from 'zod';
import { uploadDoctorPhoto, cloudinaryEnabled } from '../../middlewares/upload.middleware';
import { DoctorProfile } from '../../models';
import { sendSuccess, sendError } from '../../utils/response';

const router = Router();

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/',    asyncHandler(DoctorController.listDoctors));
router.get('/:id', validate(DoctorIdSchema), asyncHandler(DoctorController.getDoctorProfile));

// ── Hospital admin — register doctor ─────────────────────────────────────────
router.post(
  '/',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(CreateDoctorSchema),
  asyncHandler(DoctorController.registerDoctor),
);

// ── Hospital admin / super admin — create schedule ────────────────────────────
router.post(
  '/schedules',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST),
  validate(CreateScheduleSchema),
  asyncHandler(DoctorController.createSchedule),
);

// ── Upload doctor profile photo ───────────────────────────────────────────────
router.patch(
  '/:id/photo',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  (req: Request, res: Response, next) => {
    if (!cloudinaryEnabled) {
      sendError(res, 503, { code: 'CLOUDINARY_NOT_CONFIGURED', message: 'Image upload is not configured on this server.' });
      return;
    }
    uploadDoctorPhoto(req, res, (err: unknown) => {
      if (err) { sendError(res, 400, { code: 'UPLOAD_ERROR', message: (err as Error).message }); return; }
      next();
    });
  },
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req.params as Record<string, string>).id;
    const file     = req.file as (Express.Multer.File & { path?: string }) | undefined;
    if (!file) { sendError(res, 400, { code: 'FILE_REQUIRED', message: 'No photo uploaded.' }); return; }

    const photoUrl = (file as any).path ?? (file as any).secure_url ?? '';
    const doctor = await DoctorProfile.findByPk(doctorId);
    if (!doctor) { sendError(res, 404, { code: 'DOCTOR_NOT_FOUND', message: 'Doctor not found.' }); return; }

    await doctor.update({ profile_photo_url: photoUrl });
    sendSuccess(res, { profile_photo_url: photoUrl });
  }),
);

// ── Hospital admin — update booking config (break, buffer, waitlist) ─────────
router.patch(
  '/:id/booking-config',
  authenticate,
  requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body: z.object({
      break_type:                    z.enum(['split_session', 'flexible']).optional(),
      morning_end:                   z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
      afternoon_start:               z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
      break_window_start:            z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
      break_window_end:              z.string().regex(/^\d{2}:\d{2}$/).optional().nullable(),
      buffer_time_minutes:           z.number().int().min(0).max(60).optional(),
      walkin_qr_enabled:             z.boolean().optional(),
      waitlist_enabled:              z.boolean().optional(),
      waitlist_offer_expiry_minutes: z.number().int().min(5).max(120).optional(),
    }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const doctorId = (req.params as Record<string, string>).id;
    const doctor   = await DoctorProfile.findByPk(doctorId);
    if (!doctor) { sendError(res, 404, { code: 'DOCTOR_NOT_FOUND', message: 'Doctor not found.' }); return; }

    const {
      break_type, morning_end, afternoon_start,
      break_window_start, break_window_end,
      buffer_time_minutes, walkin_qr_enabled,
      waitlist_enabled, waitlist_offer_expiry_minutes,
    } = req.body;

    await doctor.update({
      ...(break_type                    != null && { break_type }),
      ...(morning_end                   !== undefined && { morning_end }),
      ...(afternoon_start               !== undefined && { afternoon_start }),
      ...(break_window_start            !== undefined && { break_window_start }),
      ...(break_window_end              !== undefined && { break_window_end }),
      ...(buffer_time_minutes           != null && { buffer_time_minutes }),
      ...(walkin_qr_enabled             != null && { walkin_qr_enabled }),
      ...(waitlist_enabled              != null && { waitlist_enabled }),
      ...(waitlist_offer_expiry_minutes != null && { waitlist_offer_expiry_minutes }),
    });

    sendSuccess(res, { message: 'Booking config updated successfully.' });
  }),
);

// ── Super admin — verify / reject doctor ──────────────────────────────────────
router.patch(
  '/:id/verify',
  authenticate,
  requireRole(UserRole.SUPER_ADMIN),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({ action: z.enum(['approve', 'reject']) }),
  })),
  asyncHandler(DoctorController.verifyDoctor),
);

export default router;
