import { Router } from 'express';
import * as PatientController from './patient.controller';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { requireCompleteProfile } from '../../middlewares/profileGuard.middleware';
import {
  CompleteProfileSchema,
  UpdateProfileSchema,
} from './patient.validation';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

// All patient routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/v1/patients/me
 * @desc    Get own profile + completeness status
 * @access  Private
 */
router.get('/me', asyncHandler(PatientController.getMyProfile));

/**
 * @route   POST /api/v1/patients/me/complete-profile
 * @desc    Fill required fields for first-time users
 * @access  Private — allowed even with incomplete profile
 */
router.post(
  '/me/complete-profile',
  validate(CompleteProfileSchema),
  asyncHandler(PatientController.completeProfile),
);

/**
 * @route   PUT /api/v1/patients/me
 * @desc    Update profile (partial update)
 * @access  Private
 */
router.put(
  '/me',
  requireCompleteProfile,       // already-complete users updating their profile
  validate(UpdateProfileSchema),
  asyncHandler(PatientController.updateProfile),
);

export default router;
