import { Router, Request, Response } from 'express';
import { z } from 'zod';
import * as DoctorAuthService from './doctor-auth.service';
import { validate } from '../../middlewares/validate.middleware';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendError, sendSuccess } from '../../utils/response';

const router = Router();

const InviteSchema = z.object({
  query: z.object({ token: z.string().min(16) }),
});

const SendOtpSchema = z.object({
  body: z.object({
    token: z.string().min(16),
  }),
});

const AcceptInviteSchema = z.object({
  body: z.object({
    token: z.string().min(16),
    otp: z.string().length(6),
    password: z.string().min(8).max(100),
  }),
});

router.get(
  '/invite',
  validate(InviteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DoctorAuthService.getInviteInfo(String(req.query.token));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.post(
  '/send-otp',
  validate(SendOtpSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await DoctorAuthService.sendDoctorOtp(req.body as { token: string });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.post(
  '/accept-invite',
  validate(AcceptInviteSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { token, otp, password } = req.body as { token: string; otp: string; password: string };
    const result = await DoctorAuthService.acceptDoctorInvite(token, otp, password);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
