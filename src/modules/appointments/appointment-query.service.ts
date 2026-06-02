import {
  Appointment, AppointmentStatus,
  DoctorProfile, Hospital, OpdSlotSession, OpdToken, DoctorReview,
}                                         from '../../models';
import { ErrorFactory }                  from '../../utils/errors';
import { ServiceResponse, ok }           from '../../types';

export async function getAppointment(appointmentId: string, requesterId: string): Promise<ServiceResponse<object>> {
  const appointment = await Appointment.findByPk(appointmentId, {
    include: [
      { model: DoctorProfile,  as: 'doctor',   attributes: ['id', 'full_name', 'specialization', 'profile_photo_url'] },
      { model: Hospital,       as: 'hospital', attributes: ['id', 'name'] },
      { model: OpdSlotSession, as: 'slot',     attributes: ['slot_start_time', 'slot_end_time', 'date', 'duration_minutes'] },
      { model: OpdToken,       as: 'opdToken', attributes: ['token_number', 'personalized_duration_minutes'] },
      { model: DoctorReview,   as: 'review',   attributes: ['id', 'rating'] },
    ],
  });
  if (!appointment) throw ErrorFactory.notFound('BOOKING_NOT_FOUND', 'Appointment not found.');
  if (appointment.patient_id !== requesterId) throw ErrorFactory.forbidden('AUTH_INSUFFICIENT_PERMISSIONS', 'Access denied.');
  return ok(appointment);
}

export async function getPatientAppointments(
  patientId: string,
  page = 1,
  perPage = 20,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const { rows, count } = await Appointment.findAndCountAll({
    where:   { patient_id: patientId },
    include: [
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name', 'specialization', 'profile_photo_url'] },
      { model: Hospital,      as: 'hospital', attributes: ['name'] },
    ],
    order:   [['scheduled_at', 'DESC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}

export async function getHospitalAppointments(
  hospitalId: string,
  status?:    AppointmentStatus,
  page  = 1,
  perPage = 20,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (status) where['status'] = status;

  const { rows, count } = await Appointment.findAndCountAll({
    where,
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
    order:   [['scheduled_at', 'ASC']],
    limit: perPage, offset: (page - 1) * perPage,
  });
  return ok({ rows, count });
}
