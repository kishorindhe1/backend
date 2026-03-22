import { z } from 'zod';

export const CreateDoctorSchema = z.object({
  body: z.object({
    mobile:               z.string().regex(/^[6-9]\d{9}$/, 'Valid 10-digit mobile required'),
    full_name:            z.string().trim().min(2).max(100),
    specialization:       z.string().trim().min(2).max(100),
    qualifications:       z.array(z.string()).min(1, 'At least one qualification required'),
    experience_years:     z.number().int().min(0).max(60),
    nmc_registration_number: z.string().trim().optional(),
    gender:               z.enum(['male', 'female', 'other']).optional(),
    languages_spoken:     z.array(z.string()).optional(),
    consultation_fee:     z.number().positive('Consultation fee must be positive'),
    hospital_id:          z.string().uuid(),
    room_number:          z.string().optional(),
    department:           z.string().optional(),
  }),
});

export const UpdateDoctorSchema = z.object({
  body: z.object({
    full_name:        z.string().trim().min(2).max(100).optional(),
    specialization:   z.string().trim().min(2).max(100).optional(),
    experience_years: z.number().int().min(0).optional(),
    bio:              z.string().max(1000).optional(),
    languages_spoken: z.array(z.string()).optional(),
  }),
});

export const CreateScheduleSchema = z.object({
  body: z.object({
    doctor_id:             z.string().uuid(),
    hospital_id:           z.string().uuid(),
    day_of_week:           z.enum(['monday','tuesday','wednesday','thursday','friday','saturday','sunday']),
    start_time:            z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
    end_time:              z.string().regex(/^\d{2}:\d{2}$/, 'Format: HH:MM'),
    slot_duration_minutes: z.number().int().min(5).max(120),
    max_patients:          z.number().int().min(1).max(500),
    session_type:          z.enum(['opd', 'emergency', 'surgery']).optional(),
    effective_from:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    effective_until:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

export const DoctorIdSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});
