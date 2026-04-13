import { Router } from 'express';
import * as AppointmentController from './appointment.controller';
import { authenticate, requireRole } from '../../middlewares/auth.middleware';
import { requireCompleteProfile }    from '../../middlewares/profileGuard.middleware';
import { validate }                  from '../../middlewares/validate.middleware';
import { bookingRateLimiter }        from '../../middlewares/rateLimit.middleware';
import {
  BookAppointmentSchema,
  CancelAppointmentSchema,
  AppointmentIdSchema,
  RejectAppointmentSchema,
  RescheduleAppointmentSchema,
} from './appointment.validation';
import { asyncHandler } from '../../utils/asyncHandler';
import { UserRole }     from '../../types';

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

// Patient routes
router.get('/my',        asyncHandler(AppointmentController.getMyAppointments));
router.get('/:id',       validate(AppointmentIdSchema),     asyncHandler(AppointmentController.getAppointment));
router.delete('/:id',    validate(CancelAppointmentSchema), asyncHandler(AppointmentController.cancelAppointment));
router.put('/:id/reschedule', validate(RescheduleAppointmentSchema), asyncHandler(AppointmentController.rescheduleAppointment));

// Hospital admin routes — accept / reject patient bookings
router.get('/hospital/pending',
  requireRole(UserRole.HOSPITAL_ADMIN),
  asyncHandler(AppointmentController.getHospitalAppointments),
);
router.put('/:id/accept',
  requireRole(UserRole.HOSPITAL_ADMIN),
  validate(AppointmentIdSchema),
  asyncHandler(AppointmentController.acceptAppointment),
);
router.put('/:id/reject',
  requireRole(UserRole.HOSPITAL_ADMIN),
  validate(RejectAppointmentSchema),
  asyncHandler(AppointmentController.rejectAppointment),
);

export default router;
