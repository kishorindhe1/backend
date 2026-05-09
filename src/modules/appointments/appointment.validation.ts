import { z } from 'zod';

export const BookAppointmentSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid('Invalid doctor ID'),
    hospital_id: z.string().uuid('Invalid hospital ID'),
    slot_id:     z.string().uuid('Invalid slot ID').optional(),
    session_id:  z.string().uuid('Invalid session ID').optional(),
    notes:            z.string().max(500).optional(),
    appointment_type: z.enum(['online_booking', 'walk_in', 'follow_up']).optional(),
    payment_mode:     z.enum(['online_prepaid', 'cash', 'card']).optional(),
  }).refine(
    (b) => Boolean(b.slot_id) !== Boolean(b.session_id),
    { message: 'Provide either slot_id (slot-based) or session_id (queue-based), not both or neither.' },
  ),
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

export const RescheduleAppointmentSchema = z.object({
  params: z.object({ id: z.string().uuid('Invalid appointment ID') }),
  body:   z.object({
    slot_id: z.string().uuid('Invalid slot ID'),
    reason:  z.string().max(300).optional(),
  }),
});
