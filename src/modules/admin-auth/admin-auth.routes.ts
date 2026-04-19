import { Router }      from 'express';
import { z }           from 'zod';
import { validate }    from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { authRateLimiter } from '../../middlewares/rateLimit.middleware';
import * as AdminAuthService from './admin-auth.service';

const router = Router();

const LoginSchema = z.object({
  body: z.object({
    email:    z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  }),
});

const TwoFactorSchema = z.object({
  body: z.object({
    email: z.string().email(),
    otp:   z.string().length(6, 'Code must be exactly 6 digits').regex(/^\d{6}$/),
  }),
});

/**
 * POST /admin/auth/login
 * Step 1: Verify email + password, send 2FA OTP to email
 */
router.post('/login', authRateLimiter, validate(LoginSchema), asyncHandler(async (req, res) => {
  const { email, password } = req.body as { email: string; password: string };
  const result = await AdminAuthService.adminLogin(email, password);
  if (!result.success) {
    res.status(result.statusCode).json({ success: false, error: { code: result.code, message: result.message } });
    return;
  }
  res.json({ success: true, data: result.data });
}));

/**
 * POST /admin/auth/verify-2fa
 * Step 2: Verify email OTP, receive JWT tokens
 */
router.post('/verify-2fa', authRateLimiter, validate(TwoFactorSchema), asyncHandler(async (req, res) => {
  const { email, otp } = req.body as { email: string; otp: string };
  const result = await AdminAuthService.verifyAdminTwoFactor(email, otp);
  if (!result.success) {
    res.status(result.statusCode).json({ success: false, error: { code: result.code, message: result.message } });
    return;
  }
  res.json({ success: true, data: result.data });
}));

const AcceptInviteSchema = z.object({
  body: z.object({
    email:    z.string().email(),
    token:    z.string().min(1),
    password: z.string().min(8, 'Password must be at least 8 characters'),
  }),
});

/**
 * POST /admin/auth/accept-invite
 * Hospital admin sets their password using the invite token from email
 */
router.post('/accept-invite', authRateLimiter, validate(AcceptInviteSchema), asyncHandler(async (req, res) => {
  const { email, token, password } = req.body as { email: string; token: string; password: string };
  const result = await AdminAuthService.acceptHospitalInvite(email, token, password);
  if (!result.success) {
    res.status(result.statusCode).json({ success: false, error: { code: result.code, message: result.message } });
    return;
  }
  res.json({ success: true, data: result.data });
}));

export default router;
