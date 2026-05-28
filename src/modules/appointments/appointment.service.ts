// Barrel re-export — keeps existing import paths working after the split.
// New code should import directly from the focused service file.
export type { BookAppointmentInput } from './appointment-booking.service';
export { bookAppointment }           from './appointment-booking.service';
export { cancelAppointment, rejectAppointment } from './appointment-cancellation.service';
export { getAppointment, getPatientAppointments, getHospitalAppointments } from './appointment-query.service';
export { rescheduleAppointment, acceptAppointment } from './appointment-lifecycle.service';
