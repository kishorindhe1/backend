import { Router } from 'express';
import * as AppointmentController from './appointment.controller';
import { authenticate }            from '../../middlewares/auth.middleware';
import { requireCompleteProfile }  from '../../middlewares/profileGuard.middleware';
import { validate }                from '../../middlewares/validate.middleware';
import { bookingRateLimiter }      from '../../middlewares/rateLimit.middleware';
import {
  BookAppointmentSchema,
  CancelAppointmentSchema,
  AppointmentIdSchema,
} from './appointment.validation';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

router.use(authenticate);

// Book — requires complete profile + booking rate limit
router.post(
  '/',
  requireCompleteProfile,
  bookingRateLimiter,
  validate(BookAppointmentSchema),
  asyncHandler(AppointmentController.bookAppointment),
);

router.get('/my',        asyncHandler(AppointmentController.getMyAppointments));
router.get('/:id',       validate(AppointmentIdSchema),     asyncHandler(AppointmentController.getAppointment));
router.delete('/:id',    validate(CancelAppointmentSchema), asyncHandler(AppointmentController.cancelAppointment));

export default router;
