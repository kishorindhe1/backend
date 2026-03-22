import { z } from 'zod';

// ── Request OTP ───────────────────────────────────────────────────────────────
export const RequestOtpSchema = z.object({
  body: z.object({
    mobile: z
      .string({ message: 'Mobile number is required' })
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    country_code: z.string().trim().default('+91'),
  }),
});

// ── Verify OTP ────────────────────────────────────────────────────────────────
export const VerifyOtpSchema = z.object({
  body: z.object({
    mobile: z
      .string({ message: 'Mobile number is required' })
      .trim()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
    otp: z
      .string({ message: 'OTP is required' })
      .trim()
      .length(6, 'OTP must be exactly 6 digits')
      .regex(/^\d{6}$/, 'OTP must contain only digits'),
  }),
});

// ── Refresh token ─────────────────────────────────────────────────────────────
export const RefreshTokenSchema = z.object({
  body: z.object({
    refresh_token: z
      .string({ message: 'Refresh token is required' })
      .trim()
      .min(1, 'Refresh token cannot be empty'),
  }),
});

// ── Inferred types ────────────────────────────────────────────────────────────
export type RequestOtpInput   = z.infer<typeof RequestOtpSchema>['body'];
export type VerifyOtpInput    = z.infer<typeof VerifyOtpSchema>['body'];
export type RefreshTokenInput = z.infer<typeof RefreshTokenSchema>['body'];
