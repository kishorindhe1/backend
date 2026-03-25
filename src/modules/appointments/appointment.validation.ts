import { z } from 'zod';

export const BookAppointmentSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid('Invalid doctor ID'),
    hospital_id: z.string().uuid('Invalid hospital ID'),
    slot_id:     z.string().uuid('Invalid slot ID'),
    notes:            z.string().max(500).optional(),
    appointment_type: z.enum(['online_booking', 'walk_in', 'follow_up']).optional(),
  }),
});

export const CancelAppointmentSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid appointment ID') }),
  body:   z.object({ reason: z.string().max(300).optional() }),
});

export const AppointmentIdSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid appointment ID') }),
});

export const RejectAppointmentSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid appointment ID') }),
  body:   z.object({ reason: z.string().max(300).optional() }),
});
