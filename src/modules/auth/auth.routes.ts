import { Router } from 'express';
import * as AuthController from './auth.controller';
import { validate }        from '../../middlewares/validate.middleware';
import { authenticate }    from '../../middlewares/auth.middleware';
import { authRateLimiter } from '../../middlewares/rateLimit.middleware';
import { RequestOtpSchema, VerifyOtpSchema, RefreshTokenSchema } from './auth.validation';
import { asyncHandler } from '../../utils/asyncHandler';

const router = Router();

/**
 * @swagger
 * /auth/request-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Send OTP to mobile number
 *     description: Sends a 6-digit OTP via SMS. In development mode, OTP is logged to console.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/RequestOtpRequest'
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 */
router.post('/request-otp', authRateLimiter, validate(RequestOtpSchema), asyncHandler(AuthController.requestOtp));

/**
 * @swagger
 * /auth/verify-otp:
 *   post:
 *     tags: [Auth]
 *     summary: Verify OTP and receive tokens
 *     description: Verifies the OTP and returns access + refresh tokens. New users will have profile_status "incomplete".
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/VerifyOtpRequest'
 *     responses:
 *       201:
 *         description: OTP verified, tokens returned
 *       401:
 *         description: Invalid or expired OTP
 */
router.post('/verify-otp', authRateLimiter, validate(VerifyOtpSchema), asyncHandler(AuthController.verifyOtp));

/**
 * @swagger
 * /auth/refresh-token:
 *   post:
 *     tags: [Auth]
 *     summary: Rotate refresh token
 *     description: Issues new access + refresh token pair. Old refresh token is invalidated.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refresh_token:
 *                 type: string
 *     responses:
 *       200:
 *         description: New token pair issued
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post('/refresh-token', validate(RefreshTokenSchema), asyncHandler(AuthController.refreshToken));

/**
 * @swagger
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Logout and invalidate tokens
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Logged out successfully
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.post('/logout', authenticate, asyncHandler(AuthController.logout));

export default router;
