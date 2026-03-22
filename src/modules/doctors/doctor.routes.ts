import { Router } from 'express';
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
