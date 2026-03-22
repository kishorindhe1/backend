/**
 * src/models/index.ts
 *
 * Single source of truth for ALL Sequelize model imports and associations.
 *
 * Import order follows FK dependency tiers — parent models before children:
 *   Tier 1: no FKs to domain models        (User, Hospital)
 *   Tier 2: FK → Tier 1 only               (PatientProfile, HospitalStaff, DoctorProfile)
 *   Tier 3: FK → Tier 1 + Tier 2           (DoctorHospitalAffiliation, Schedule)
 *   Tier 4: FK → Tier 3                    (GeneratedSlot)
 *   Tier 5: FK → Tier 1/2/4               (Appointment)
 *   Tier 6: FK → Tier 5                    (Payment, WebhookEvent)
 *
 * Every module that needs a model should import from here, not from the model file directly:
 *   import { User, DoctorProfile } from '../../models';
 */

// ── Tier 1 ────────────────────────────────────────────────────────────────────
export { User }                        from './user.model';
export { Hospital, HospitalType, OnboardingStatus } from './hospital.model';

// ── Tier 2 ────────────────────────────────────────────────────────────────────
export { PatientProfile, Gender }      from './patient.model';
export { HospitalStaff, StaffRole }    from './hospital-staff.model';
export {
  DoctorProfile, BookingMode, VerificationStatus,
}                                      from './doctor.model';

// ── Tier 3 ────────────────────────────────────────────────────────────────────
export { DoctorHospitalAffiliation }   from './doctor-affiliation.model';
export { Schedule, DayOfWeek, SessionType } from './schedule.model';

// ── Tier 4 ────────────────────────────────────────────────────────────────────
export { GeneratedSlot, SlotStatus }   from './slot.model';

// ── Tier 5 ────────────────────────────────────────────────────────────────────
export {
  Appointment,
  AppointmentStatus,
  PaymentStatus,
  AppointmentType,
  PaymentMode,
  CancellationBy,
}                                      from './appointment.model';

// ── Tier 6 ────────────────────────────────────────────────────────────────────
export {
  Payment, PaymentGatewayStatus,
  WebhookEvent, WebhookStatus,
}                                      from './payment.model';

// ── Phase 3 models ─────────────────────────────────────────────────────────────
export {
  ConsultationQueue, QueueStatus,
}                                      from './consultation-queue.model';
export {
  DoctorDelayEvent, DelayStatus, DelayType,
}                                      from './doctor-delay-event.model';
export {
  NotificationLog, NotificationChannel, NotificationStatus,
}                                      from './notification-log.model';
export {
  UserNotificationPreference,
}                                      from './notification-preference.model';
export {
  OpdSession, OpdBookingMode, OpdSessionStatus,
}                                      from './opd-session.model';
export {
  OpdToken, OpdTokenType, OpdTokenStatus,
}                                      from './opd-token.model';

// ── Phase 4 models ─────────────────────────────────────────────────────────────
export { DoctorSearchIndex }               from './doctor-search-index.model';
export { SymptomSpecialisationMap }        from './symptom-map.model';

import { DoctorSearchIndex }           from './doctor-search-index.model';

// ═════════════════════════════════════════════════════════════════════════════
// ALL ASSOCIATIONS — defined once here, never inside individual model files
// ═════════════════════════════════════════════════════════════════════════════

import { User }                       from './user.model';
import { PatientProfile }             from './patient.model';
import { Hospital }                   from './hospital.model';
import { HospitalStaff }              from './hospital-staff.model';
import { DoctorProfile }              from './doctor.model';
import { DoctorHospitalAffiliation }  from './doctor-affiliation.model';
import { Schedule }                   from './schedule.model';
import { GeneratedSlot }              from './slot.model';
import { Appointment }                from './appointment.model';
import { Payment }                    from './payment.model';
import { ConsultationQueue }          from './consultation-queue.model';
import { DoctorDelayEvent }           from './doctor-delay-event.model';
import { NotificationLog }            from './notification-log.model';
import { UserNotificationPreference } from './notification-preference.model';
import { OpdSession }                 from './opd-session.model';
import { OpdToken }                   from './opd-token.model';

// ── User associations ─────────────────────────────────────────────────────────
User.hasOne(PatientProfile,  { foreignKey: 'user_id', as: 'patientProfile', onDelete: 'RESTRICT' });
PatientProfile.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasOne(DoctorProfile,   { foreignKey: 'user_id', as: 'doctorProfile',  onDelete: 'RESTRICT' });
DoctorProfile.belongsTo(User,  { foreignKey: 'user_id', as: 'user' });

User.hasMany(HospitalStaff,  { foreignKey: 'user_id', as: 'staffRoles' });
HospitalStaff.belongsTo(User,  { foreignKey: 'user_id', as: 'user' });

User.hasMany(Appointment,    { foreignKey: 'patient_id', as: 'appointments' });
Appointment.belongsTo(User,    { foreignKey: 'patient_id', as: 'patient' });

User.hasMany(NotificationLog, { foreignKey: 'user_id', as: 'notificationLogs' });
NotificationLog.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

User.hasOne(UserNotificationPreference, { foreignKey: 'user_id', as: 'notificationPreference' });
UserNotificationPreference.belongsTo(User, { foreignKey: 'user_id', as: 'user' });

// ── Hospital associations ─────────────────────────────────────────────────────
Hospital.hasMany(HospitalStaff,             { foreignKey: 'hospital_id', as: 'staff' });
HospitalStaff.belongsTo(Hospital,             { foreignKey: 'hospital_id', as: 'hospital' });

Hospital.hasMany(DoctorHospitalAffiliation, { foreignKey: 'hospital_id', as: 'doctorAffiliations' });
DoctorHospitalAffiliation.belongsTo(Hospital, { foreignKey: 'hospital_id', as: 'hospital' });

Hospital.hasMany(Schedule,                 { foreignKey: 'hospital_id', as: 'schedules' });
Schedule.belongsTo(Hospital,                 { foreignKey: 'hospital_id', as: 'hospital' });

Hospital.hasMany(GeneratedSlot,            { foreignKey: 'hospital_id', as: 'slots' });
GeneratedSlot.belongsTo(Hospital,            { foreignKey: 'hospital_id', as: 'hospital' });

Hospital.hasMany(Appointment,              { foreignKey: 'hospital_id', as: 'appointments' });
Appointment.belongsTo(Hospital,              { foreignKey: 'hospital_id', as: 'hospital' });

Hospital.hasMany(OpdSession,               { foreignKey: 'hospital_id', as: 'opdSessions' });
OpdSession.belongsTo(Hospital,               { foreignKey: 'hospital_id', as: 'hospital' });

// ── DoctorProfile associations ────────────────────────────────────────────────
DoctorProfile.hasMany(DoctorHospitalAffiliation, { foreignKey: 'doctor_id', as: 'affiliations' });
DoctorHospitalAffiliation.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(Schedule,            { foreignKey: 'doctor_id', as: 'schedules' });
Schedule.belongsTo(DoctorProfile,            { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(GeneratedSlot,       { foreignKey: 'doctor_id', as: 'slots' });
GeneratedSlot.belongsTo(DoctorProfile,       { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(Appointment,         { foreignKey: 'doctor_id', as: 'appointments' });
Appointment.belongsTo(DoctorProfile,         { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(ConsultationQueue,   { foreignKey: 'doctor_id', as: 'queueEntries' });
ConsultationQueue.belongsTo(DoctorProfile,   { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(DoctorDelayEvent,    { foreignKey: 'doctor_id', as: 'delayEvents' });
DoctorDelayEvent.belongsTo(DoctorProfile,    { foreignKey: 'doctor_id', as: 'doctor' });

DoctorProfile.hasMany(OpdSession,          { foreignKey: 'doctor_id', as: 'opdSessions' });
OpdSession.belongsTo(DoctorProfile,          { foreignKey: 'doctor_id', as: 'doctor' });

// ── Schedule → Slot ───────────────────────────────────────────────────────────
Schedule.hasMany(GeneratedSlot, { foreignKey: 'schedule_id', as: 'slots' });
GeneratedSlot.belongsTo(Schedule, { foreignKey: 'schedule_id', as: 'schedule' });

// ── Slot → Appointment (one-to-one) ──────────────────────────────────────────
GeneratedSlot.hasOne(Appointment,  { foreignKey: 'slot_id', as: 'appointment' });
Appointment.belongsTo(GeneratedSlot, { foreignKey: 'slot_id', as: 'slot' });

// ── Appointment associations ──────────────────────────────────────────────────
Appointment.hasOne(Payment,        { foreignKey: 'appointment_id', as: 'payment' });
Payment.belongsTo(Appointment,       { foreignKey: 'appointment_id', as: 'appointment' });

Appointment.hasOne(ConsultationQueue, { foreignKey: 'appointment_id', as: 'queueEntry' });
ConsultationQueue.belongsTo(Appointment, { foreignKey: 'appointment_id', as: 'appointment' });

// ── OPD Session → Token ───────────────────────────────────────────────────────
OpdSession.hasMany(OpdToken,       { foreignKey: 'session_id', as: 'tokens' });
OpdToken.belongsTo(OpdSession,       { foreignKey: 'session_id', as: 'session' });

User.hasMany(OpdToken,             { foreignKey: 'patient_id', as: 'opdTokens' });
OpdToken.belongsTo(User,             { foreignKey: 'patient_id', as: 'patient' });

Appointment.hasOne(OpdToken,       { foreignKey: 'appointment_id', as: 'opdToken' });
OpdToken.belongsTo(Appointment,      { foreignKey: 'appointment_id', as: 'appointment' });
