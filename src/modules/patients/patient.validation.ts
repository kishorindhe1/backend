import { z } from 'zod';
import { Gender } from '../../models';

const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

// ── Complete profile (first-time fill) ────────────────────────────────────────
export const CompleteProfileSchema = z.object({
  body: z.object({
    full_name: z
      .string({ message: 'Full name is required' })
      .trim()
      .min(2, 'Full name must be at least 2 characters')
      .max(100, 'Full name must not exceed 100 characters'),

    date_of_birth: z
      .string({ message: 'Date of birth is required' })
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date of birth must be in YYYY-MM-DD format')
      .refine((val) => {
        const date    = new Date(val);
        const now     = new Date();
        const minDate = new Date('1900-01-01');
        return date < now && date > minDate;
      }, 'Enter a valid date of birth'),

    gender: z.nativeEnum(Gender, { message: 'Gender is required or invalid' }),

    // Optional
    email: z.string().trim().email('Enter a valid email address').optional().or(z.literal('')),

    blood_group: z.enum(BLOOD_GROUPS).optional(),
  }),
});

// ── Update profile (partial) ──────────────────────────────────────────────────
export const UpdateProfileSchema = z.object({
  body: z
    .object({
      full_name:     z.string().trim().min(2).max(100).optional(),
      date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      gender:        z.nativeEnum(Gender).optional(),
      email:         z.string().trim().email().optional().or(z.literal('')),
      blood_group:   z.enum(BLOOD_GROUPS).optional(),
    })
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided',
    }),
});

// ── Notification preferences ──────────────────────────────────────────────────
export const UpdateNotifPrefsSchema = z.object({
  body: z.object({
    sms_enabled:              z.boolean().optional(),
    push_enabled:             z.boolean().optional(),
    email_enabled:            z.boolean().optional(),
    booking_reminders:        z.boolean().optional(),
    delay_alerts:             z.boolean().optional(),
    queue_position_alerts:    z.boolean().optional(),
    quiet_hours_enabled:      z.boolean().optional(),
    quiet_hours_start:        z.string().regex(/^\d{2}:\d{2}$/).optional(),
    quiet_hours_end:          z.string().regex(/^\d{2}:\d{2}$/).optional(),
    queue_notify_at_position: z.number().int().min(1).max(10).optional(),
  }),
});

// ── Inferred types ────────────────────────────────────────────────────────────
export type CompleteProfileInput  = z.infer<typeof CompleteProfileSchema>['body'];
export type UpdateProfileInput    = z.infer<typeof UpdateProfileSchema>['body'];
export type UpdateNotifPrefsInput = z.infer<typeof UpdateNotifPrefsSchema>['body'];
