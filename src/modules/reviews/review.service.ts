import { DoctorReview } from '../../models/review.model';
import { Appointment, AppointmentStatus, DoctorProfile, PatientProfile } from '../../models';
import { User } from '../../models';
import { ServiceResponse, ok, fail } from '../../types';
import { logger } from '../../utils/logger';

// ── Write a review ────────────────────────────────────────────────────────────
export async function createReview(input: {
  patient_id:     string;
  doctor_id:      string;
  appointment_id: string;
  rating:         number;
  comment?:       string;
}): Promise<ServiceResponse<object>> {
  // Verify the appointment belongs to this patient and is completed
  const appointment = await Appointment.findOne({
    where: { id: input.appointment_id, patient_id: input.patient_id, doctor_id: input.doctor_id },
  });
  if (!appointment) return fail('APPOINTMENT_NOT_FOUND', 'Appointment not found.', 404);
  if (appointment.status !== AppointmentStatus.COMPLETED) {
    return fail('APPOINTMENT_NOT_COMPLETED', 'You can only review a completed appointment.', 422);
  }

  // One review per appointment
  const existing = await DoctorReview.findOne({ where: { appointment_id: input.appointment_id } });
  if (existing) return fail('REVIEW_ALREADY_EXISTS', 'You have already reviewed this appointment.', 409);

  const review = await DoctorReview.create({
    patient_id:     input.patient_id,
    doctor_id:      input.doctor_id,
    appointment_id: input.appointment_id,
    rating:         input.rating,
    comment:        input.comment ?? null,
  });

  logger.info('Review created', { reviewId: review.id, doctorId: input.doctor_id });
  return ok(review);
}

// ── Get reviews for a doctor ──────────────────────────────────────────────────
export async function getDoctorReviews(doctorId: string, page: number, perPage: number): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await DoctorReview.findAndCountAll({
    where: { doctor_id: doctorId },
    include: [{ model: User, as: 'patient', attributes: ['id'], include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'] }] }],
    order:  [['created_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}

// ── My reviews ────────────────────────────────────────────────────────────────
export async function getMyReviews(patientId: string, page: number, perPage: number): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await DoctorReview.findAndCountAll({
    where: { patient_id: patientId },
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['id', 'full_name', 'specialization'] }],
    order:  [['created_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}
