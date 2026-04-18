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
export { Hospital, HospitalType, OnboardingStatus, AppointmentApprovalMode, PaymentCollectionMode } from './hospital.model';

// ── Tier 2 ────────────────────────────────────────────────────────────────────
export { PatientProfile, Gender }      from './patient.model';
export { HospitalStaff, StaffRole }    from './hospital-staff.model';
export {
  DoctorProfile, BookingMode, VerificationStatus,
}                                      from './doctor.model';

// ── Tier 3 ────────────────────────────────────────────────────────────────────
export { DoctorHospitalAffiliation, EmploymentType, SlotAutonomyLevel } from './doctor-affiliation.model';
export { Schedule, DayOfWeek, SessionType, ScheduleBookingMode } from './schedule.model';

// ── Tier 4 ────────────────────────────────────────────────────────────────────
export { GeneratedSlot, SlotStatus }   from './slot.model';
export { OpdSlotSession, OpdSlotStatus, SlotCategory, BookingEngine, SlotType } from './opd-slot-session.model';
export { ProcedureType, ProcedureCategory }                           from './procedure-type.model';
export { DoctorAvailabilityWindow, WindowBookingMode }                from './doctor-availability-window.model';
export { DoctorAvailabilityOverride, OverrideType }                   from './doctor-availability-override.model';
export { DoctorBookingPreference }                                    from './doctor-booking-preference.model';
export { HospitalClosure, ClosureType }                               from './hospital-closure.model';
export { SlotTemplate, TemplateAppliesTo }                            from './slot-template.model';

// ── Tier 5 ────────────────────────────────────────────────────────────────────
export {
  Appointment,
  AppointmentStatus,
  PaymentStatus,
  AppointmentType,
  PaymentMode,
  CancellationBy,
  VisitType,
  PriorityTier,
}                                      from './appointment.model';
export { WalkInToken, WalkInTokenStatus }   from './walk-in-token.model';
export { WaitlistEntry, WaitlistStatus }    from './waitlist-entry.model';
export { NoShowLog }                        from './no-show-log.model';
export { OpdReviewLog }                     from './opd-review-log.model';
export { SlotChangeLog, SlotChangeType, SlotChangeScope } from './slot-change-log.model';
export { OpdDailyStats }                    from './opd-daily-stats.model';

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

// ── Phase 5 models ─────────────────────────────────────────────────────────────
export { DoctorReview }                    from './review.model';
export { HealthRecord, RecordType }        from './health-record.model';

// ── Admin ──────────────────────────────────────────────────────────────────────
export { AdminAuditLog, AdminAction }      from './admin-audit-log.model';

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
import { DoctorReview }              from './review.model';
import { HealthRecord }              from './health-record.model';

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

// ── Reviews ───────────────────────────────────────────────────────────────────
User.hasMany(DoctorReview,         { foreignKey: 'patient_id', as: 'reviews' });
DoctorReview.belongsTo(User,         { foreignKey: 'patient_id', as: 'patient' });

DoctorProfile.hasMany(DoctorReview, { foreignKey: 'doctor_id', as: 'reviews' });
DoctorReview.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Appointment.hasOne(DoctorReview,   { foreignKey: 'appointment_id', as: 'review' });
DoctorReview.belongsTo(Appointment,  { foreignKey: 'appointment_id', as: 'appointment' });

// ── Health Records ────────────────────────────────────────────────────────────
User.hasMany(HealthRecord,         { foreignKey: 'patient_id', as: 'healthRecords' });
HealthRecord.belongsTo(User,         { foreignKey: 'patient_id', as: 'patient' });

// ── Admin Audit Logs ──────────────────────────────────────────────────────────
import { AdminAuditLog }           from './admin-audit-log.model';
User.hasMany(AdminAuditLog,        { foreignKey: 'admin_id',   as: 'auditLogs' });
AdminAuditLog.belongsTo(User,        { foreignKey: 'admin_id',   as: 'admin' });

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — Slot Governance associations
// ═════════════════════════════════════════════════════════════════════════════

import { OpdSlotSession }              from './opd-slot-session.model';
import { ProcedureType }               from './procedure-type.model';
import { DoctorAvailabilityWindow }    from './doctor-availability-window.model';
import { DoctorAvailabilityOverride }  from './doctor-availability-override.model';
import { DoctorBookingPreference }     from './doctor-booking-preference.model';
import { HospitalClosure }             from './hospital-closure.model';
import { SlotTemplate }                from './slot-template.model';
import { WalkInToken }                 from './walk-in-token.model';
import { WaitlistEntry }               from './waitlist-entry.model';
import { NoShowLog }                   from './no-show-log.model';
import { OpdReviewLog }                from './opd-review-log.model';
import { SlotChangeLog }               from './slot-change-log.model';
import { OpdDailyStats }               from './opd-daily-stats.model';

// ── OpdSlotSession ────────────────────────────────────────────────────────────
DoctorProfile.hasMany(OpdSlotSession,  { foreignKey: 'doctor_id',   as: 'opdSlotSessions' });
OpdSlotSession.belongsTo(DoctorProfile,  { foreignKey: 'doctor_id',   as: 'doctor' });

Hospital.hasMany(OpdSlotSession,       { foreignKey: 'hospital_id', as: 'opdSlotSessions' });
OpdSlotSession.belongsTo(Hospital,       { foreignKey: 'hospital_id', as: 'hospital' });

Schedule.hasMany(OpdSlotSession,       { foreignKey: 'schedule_id', as: 'opdSlotSessions' });
OpdSlotSession.belongsTo(Schedule,       { foreignKey: 'schedule_id', as: 'schedule' });

// ── ProcedureType ─────────────────────────────────────────────────────────────
DoctorProfile.hasMany(ProcedureType,   { foreignKey: 'doctor_id',   as: 'procedureTypes' });
ProcedureType.belongsTo(DoctorProfile,   { foreignKey: 'doctor_id',   as: 'doctor' });

Hospital.hasMany(ProcedureType,        { foreignKey: 'hospital_id', as: 'procedureTypes' });
ProcedureType.belongsTo(Hospital,        { foreignKey: 'hospital_id', as: 'hospital' });

// ── DoctorAvailabilityWindow ──────────────────────────────────────────────────
DoctorProfile.hasMany(DoctorAvailabilityWindow, { foreignKey: 'doctor_id',   as: 'availabilityWindows' });
DoctorAvailabilityWindow.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Hospital.hasMany(DoctorAvailabilityWindow,      { foreignKey: 'hospital_id', as: 'availabilityWindows' });
DoctorAvailabilityWindow.belongsTo(Hospital,      { foreignKey: 'hospital_id', as: 'hospital' });

// ── DoctorAvailabilityOverride ────────────────────────────────────────────────
DoctorProfile.hasMany(DoctorAvailabilityOverride, { foreignKey: 'doctor_id',   as: 'availabilityOverrides' });
DoctorAvailabilityOverride.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Hospital.hasMany(DoctorAvailabilityOverride,      { foreignKey: 'hospital_id', as: 'availabilityOverrides' });
DoctorAvailabilityOverride.belongsTo(Hospital,      { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(DoctorAvailabilityOverride,          { foreignKey: 'created_by',  as: 'createdOverrides' });
DoctorAvailabilityOverride.belongsTo(User,          { foreignKey: 'created_by',  as: 'createdByUser' });

// ── DoctorBookingPreference ───────────────────────────────────────────────────
DoctorProfile.hasMany(DoctorBookingPreference, { foreignKey: 'doctor_id',   as: 'bookingPreferences' });
DoctorBookingPreference.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Hospital.hasMany(DoctorBookingPreference,      { foreignKey: 'hospital_id', as: 'doctorBookingPreferences' });
DoctorBookingPreference.belongsTo(Hospital,      { foreignKey: 'hospital_id', as: 'hospital' });

// ── HospitalClosure ───────────────────────────────────────────────────────────
Hospital.hasMany(HospitalClosure, { foreignKey: 'hospital_id', as: 'closures' });
HospitalClosure.belongsTo(Hospital, { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(HospitalClosure,     { foreignKey: 'created_by',  as: 'createdClosures' });
HospitalClosure.belongsTo(User,     { foreignKey: 'created_by',  as: 'createdByUser' });

// ── SlotTemplate ──────────────────────────────────────────────────────────────
Hospital.hasMany(SlotTemplate,    { foreignKey: 'hospital_id', as: 'slotTemplates' });
SlotTemplate.belongsTo(Hospital,    { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(SlotTemplate,        { foreignKey: 'created_by',  as: 'createdTemplates' });
SlotTemplate.belongsTo(User,        { foreignKey: 'created_by',  as: 'createdByUser' });

// ── WalkInToken ───────────────────────────────────────────────────────────────
DoctorProfile.hasMany(WalkInToken, { foreignKey: 'doctor_id',   as: 'walkInTokens' });
WalkInToken.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Hospital.hasMany(WalkInToken,      { foreignKey: 'hospital_id', as: 'walkInTokens' });
WalkInToken.belongsTo(Hospital,      { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(WalkInToken,          { foreignKey: 'patient_id',  as: 'walkInTokens' });
WalkInToken.belongsTo(User,          { foreignKey: 'patient_id',  as: 'patient' });

// ── WaitlistEntry ─────────────────────────────────────────────────────────────
DoctorProfile.hasMany(WaitlistEntry, { foreignKey: 'doctor_id',   as: 'waitlistEntries' });
WaitlistEntry.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

Hospital.hasMany(WaitlistEntry,      { foreignKey: 'hospital_id', as: 'waitlistEntries' });
WaitlistEntry.belongsTo(Hospital,      { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(WaitlistEntry,          { foreignKey: 'patient_id',  as: 'waitlistEntries' });
WaitlistEntry.belongsTo(User,          { foreignKey: 'patient_id',  as: 'patient' });

// ── NoShowLog ─────────────────────────────────────────────────────────────────
Appointment.hasOne(NoShowLog,      { foreignKey: 'appointment_id', as: 'noShowLog' });
NoShowLog.belongsTo(Appointment,     { foreignKey: 'appointment_id', as: 'appointment' });

User.hasMany(NoShowLog,            { foreignKey: 'patient_id',     as: 'noShowLogs' });
NoShowLog.belongsTo(User,            { foreignKey: 'patient_id',     as: 'patient' });

DoctorProfile.hasMany(NoShowLog,   { foreignKey: 'doctor_id',      as: 'noShowLogs' });
NoShowLog.belongsTo(DoctorProfile,   { foreignKey: 'doctor_id',      as: 'doctor' });

// ── OpdReviewLog ──────────────────────────────────────────────────────────────
Hospital.hasMany(OpdReviewLog,     { foreignKey: 'hospital_id', as: 'reviewLogs' });
OpdReviewLog.belongsTo(Hospital,     { foreignKey: 'hospital_id', as: 'hospital' });

User.hasMany(OpdReviewLog,         { foreignKey: 'reviewed_by',  as: 'opdReviews' });
OpdReviewLog.belongsTo(User,         { foreignKey: 'reviewed_by',  as: 'reviewedByUser' });

// ── SlotChangeLog ─────────────────────────────────────────────────────────────
Hospital.hasMany(SlotChangeLog,    { foreignKey: 'hospital_id', as: 'slotChangeLogs' });
SlotChangeLog.belongsTo(Hospital,    { foreignKey: 'hospital_id', as: 'hospital' });

DoctorProfile.hasMany(SlotChangeLog, { foreignKey: 'doctor_id',  as: 'slotChangeLogs' });
SlotChangeLog.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });

User.hasMany(SlotChangeLog,          { foreignKey: 'created_by', as: 'slotChangeLogs' });
SlotChangeLog.belongsTo(User,          { foreignKey: 'created_by', as: 'createdByUser' });

// ── OpdDailyStats ─────────────────────────────────────────────────────────────
Hospital.hasMany(OpdDailyStats,    { foreignKey: 'hospital_id', as: 'dailyStats' });
OpdDailyStats.belongsTo(Hospital,    { foreignKey: 'hospital_id', as: 'hospital' });

DoctorProfile.hasMany(OpdDailyStats, { foreignKey: 'doctor_id',  as: 'dailyStats' });
OpdDailyStats.belongsTo(DoctorProfile, { foreignKey: 'doctor_id', as: 'doctor' });
