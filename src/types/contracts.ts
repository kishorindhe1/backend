/**
 * Shared API contract schemas — single source of truth for request/response shapes.
 *
 * These Zod schemas are used by:
 *   1. The backend for validation (via validate.middleware.ts)
 *   2. The admin panel and patient app for typed API calls
 *
 * To share with frontend: copy this file into a shared package or expose via
 * GET /api/v1/contracts (auto-generate from these definitions).
 */
import { z } from 'zod';

// ── Primitives ─────────────────────────────────────────────────────────────────
const uuid  = z.string().uuid();
const date  = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD');
const time  = z.string().regex(/^\d{2}:\d{2}$/, 'Must be HH:MM');
const page  = z.coerce.number().int().min(1).default(1);
const perPage = z.coerce.number().int().min(1).max(100).default(20);

// ── Auth ───────────────────────────────────────────────────────────────────────
export const SendOtpSchema = z.object({
  mobile:       z.string().regex(/^[6-9]\d{9}$/, 'Invalid Indian mobile number'),
  country_code: z.string().default('+91'),
});

export const VerifyOtpSchema = z.object({
  mobile:       z.string(),
  country_code: z.string().default('+91'),
  otp:          z.string().length(6),
});

export type SendOtpInput   = z.infer<typeof SendOtpSchema>;
export type VerifyOtpInput = z.infer<typeof VerifyOtpSchema>;

// ── Booking ────────────────────────────────────────────────────────────────────
export const BookAppointmentSchema = z.object({
  doctor_id:         uuid,
  hospital_id:       uuid,
  slot_id:           uuid.optional(),
  session_id:        uuid.optional(),
  notes:             z.string().max(1000).optional(),
  appointment_type:  z.enum(['online_booking', 'walk_in', 'follow_up', 'teleconsult']).optional(),
  payment_mode:      z.enum(['cash', 'card', 'online_prepaid']).optional(),
}).refine((d) => d.slot_id || d.session_id, { message: 'Either slot_id or session_id is required' });

export const CancelAppointmentSchema = z.object({
  reason: z.string().max(500).optional(),
});

export const RescheduleAppointmentSchema = z.object({
  new_slot_id: uuid,
  reason:      z.string().max(500).optional(),
});

export type BookAppointmentInput       = z.infer<typeof BookAppointmentSchema>;
export type CancelAppointmentInput     = z.infer<typeof CancelAppointmentSchema>;
export type RescheduleAppointmentInput = z.infer<typeof RescheduleAppointmentSchema>;

// ── Queries ────────────────────────────────────────────────────────────────────
export const PaginationSchema = z.object({ page, per_page: perPage });
export const DateQuerySchema  = z.object({ date: date.optional() });

export type PaginationInput = z.infer<typeof PaginationSchema>;
export type DateQueryInput  = z.infer<typeof DateQuerySchema>;

// ── Health Record ──────────────────────────────────────────────────────────────
export const CreateHealthRecordSchema = z.object({
  title:       z.string().min(1).max(200),
  record_type: z.enum(['lab_report', 'prescription', 'imaging', 'vaccination', 'discharge', 'other']),
  notes:       z.string().max(2000).optional(),
  record_date: date.optional(),
});

export type CreateHealthRecordInput = z.infer<typeof CreateHealthRecordSchema>;

// ── Doctor Search ──────────────────────────────────────────────────────────────
export const DoctorSearchSchema = z.object({
  q:            z.string().min(1).max(100),
  hospital_id:  uuid.optional(),
  date:         date.optional(),
  page,
  per_page:     perPage,
});

export type DoctorSearchInput = z.infer<typeof DoctorSearchSchema>;

// ── OPD Session ───────────────────────────────────────────────────────────────
export const CreateOpdSessionSchema = z.object({
  doctor_id:         uuid,
  session_date:      date,
  start_time:        time,
  end_time:          time,
  total_tokens:      z.number().int().min(1).max(500),
  avg_time_minutes:  z.number().int().min(1).max(60).default(10),
  booking_mode:      z.enum(['token_based', 'slot_based']).default('token_based'),
  session_type:      z.enum(['opd', 'teleconsult']).default('opd'),
});

export type CreateOpdSessionInput = z.infer<typeof CreateOpdSessionSchema>;
