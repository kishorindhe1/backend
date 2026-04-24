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
