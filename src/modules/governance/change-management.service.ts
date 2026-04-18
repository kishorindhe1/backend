import { Op }                          from 'sequelize';
import {
  DoctorAvailabilityOverride, OverrideType,
  OpdSlotSession, OpdSlotStatus,
  SlotChangeLog, SlotChangeType, SlotChangeScope,
  Appointment, AppointmentStatus, CancellationBy, PaymentStatus,
  DoctorProfile,
  PatientProfile,
}                                       from '../../models';
import { redis, RedisKeys }             from '../../config/redis';
import { enqueueNotification }          from '../notifications/notification.service';
import { NotificationChannel }          from '../../models';
import { ServiceResponse, ok, fail }    from '../../types';
import { logger }                       from '../../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ApplyOverrideInput {
  doctorId:    string;
  hospitalId:  string;
  date:        string;           // YYYY-MM-DD
  overrideType: OverrideType;
  startTime?:  string;           // HH:MM — required for late_start, break, extra_hours, running_late
  endTime?:    string;           // HH:MM — required for early_end, break, extra_hours
  delayMinutes?: number;         // required for running_late
  reason?:     string;
  createdBy:   string;           // user_id of receptionist
  scope:       SlotChangeScope;
}

export interface OverrideResult {
  override_id:         string;
  slots_cancelled:     number;
  patients_notified:   number;
  change_log_id:       string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Apply a doctor availability override
// ─────────────────────────────────────────────────────────────────────────────

export async function applyOverride(
  input: ApplyOverrideInput,
): Promise<ServiceResponse<OverrideResult>> {

  const { doctorId, hospitalId, date, overrideType, startTime, endTime, delayMinutes, reason, createdBy, scope } = input;

  // Validate required fields per override type
  if (overrideType === OverrideType.LATE_START && !startTime) {
    return fail('INVALID_OVERRIDE', 'start_time is required for late_start override.', 400);
  }
  if (overrideType === OverrideType.EARLY_END && !endTime) {
    return fail('INVALID_OVERRIDE', 'end_time is required for early_end override.', 400);
  }
  if (overrideType === OverrideType.BREAK && (!startTime || !endTime)) {
    return fail('INVALID_OVERRIDE', 'start_time and end_time are required for break override.', 400);
  }
  if (overrideType === OverrideType.EXTRA_HOURS && (!startTime || !endTime)) {
    return fail('INVALID_OVERRIDE', 'start_time and end_time are required for extra_hours override.', 400);
  }
  if (overrideType === OverrideType.RUNNING_LATE && !delayMinutes) {
    return fail('INVALID_OVERRIDE', 'delay_minutes is required for running_late override.', 400);
  }

  // Create override record
  const override = await DoctorAvailabilityOverride.create({
    doctor_id:     doctorId,
    hospital_id:   hospitalId,
    date,
    override_type: overrideType,
    start_time:    startTime ?? null,
    end_time:      endTime   ?? null,
    delay_minutes: delayMinutes ?? null,
    reason:        reason   ?? null,
    created_by:    createdBy,
  });

  // Determine which published slots are now invalidated
  const slotsToCancel = await findInvalidatedSlots(doctorId, hospitalId, date, overrideType, startTime, endTime);

  // Snapshot current state for rollback
  const snapshot = slotsToCancel.map((s) => ({
    id:              s.id,
    status:          s.status,
    slot_start_time: s.slot_start_time,
    slot_end_time:   s.slot_end_time,
    appointment_id:  s.appointment_id,
  }));

  // Cancel invalidated slots + notify booked patients
  let slotsCancelled   = 0;
  let patientsNotified = 0;

  if (slotsToCancel.length > 0) {
    const doctor = await DoctorProfile.findByPk(doctorId, { attributes: ['full_name'] });

    for (const slot of slotsToCancel) {
      const prevStatus = slot.status;
      await slot.update({ status: OpdSlotStatus.CANCELLED });

      // If a booked appointment exists, cancel it and notify patient
      if (slot.appointment_id) {
        await cancelAppointmentForOverride(slot.appointment_id, doctorId, hospitalId, date, doctor?.full_name ?? 'Doctor', overrideType, delayMinutes);
        patientsNotified++;
      }

      slotsCancelled++;
    }

    // Invalidate caches
    await redis.del(RedisKeys.availableSlots(doctorId, date));
    await redis.del(RedisKeys.publishedSlots(doctorId, date));
  }

  // For running_late — notify all booked patients (slots stay, but times shift)
  if (overrideType === OverrideType.RUNNING_LATE) {
    patientsNotified += await notifyRunningLate(doctorId, hospitalId, date, delayMinutes!, reason);
  }

  // Write change log
  const changeLog = await SlotChangeLog.create({
    hospital_id:              hospitalId,
    doctor_id:                doctorId,
    date,
    change_type:              SlotChangeType.OVERRIDE_APPLIED,
    scope,
    slots_affected:           slotsCancelled,
    booked_patients_notified: patientsNotified,
    previous_state_snapshot:  snapshot.length > 0 ? snapshot : null,
    reason:                   reason ?? null,
    created_by:               createdBy,
  });

  logger.info('Override applied', { overrideType, doctorId, hospitalId, date, slotsCancelled, patientsNotified });

  return ok({
    override_id:       override.id,
    slots_cancelled:   slotsCancelled,
    patients_notified: patientsNotified,
    change_log_id:     changeLog.id,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rollback a change (restore slots to previous state)
// ─────────────────────────────────────────────────────────────────────────────

export async function rollbackChange(
  changeLogId: string,
  rolledBackBy: string,
): Promise<ServiceResponse<{ restored: number }>> {

  const log = await SlotChangeLog.findByPk(changeLogId);
  if (!log) return fail('CHANGE_LOG_NOT_FOUND', 'Change log entry not found.', 404);
  if (!log.previous_state_snapshot) return fail('NO_SNAPSHOT', 'No snapshot available for rollback.', 409);

  const snapshot = log.previous_state_snapshot as Array<{
    id: string; status: string; slot_start_time: string; slot_end_time: string; appointment_id: string | null;
  }>;

  let restored = 0;
  for (const entry of snapshot) {
    const slot = await OpdSlotSession.findByPk(entry.id);
    if (!slot) continue;

    await slot.update({
      status:         entry.status as OpdSlotStatus,
      appointment_id: entry.appointment_id,
    });
    restored++;
  }

  // Log the rollback itself
  await SlotChangeLog.create({
    hospital_id:              log.hospital_id,
    doctor_id:                log.doctor_id,
    date:                     log.date,
    change_type:              SlotChangeType.ROLLBACK,
    scope:                    log.scope,
    slots_affected:           restored,
    booked_patients_notified: 0,
    previous_state_snapshot:  null,
    reason:                   `Rollback of change log ${changeLogId}`,
    created_by:               rolledBackBy,
  });

  await redis.del(RedisKeys.availableSlots(log.doctor_id, log.date));
  await redis.del(RedisKeys.publishedSlots(log.doctor_id, log.date));

  logger.info('Change rolled back', { changeLogId, restored, rolledBackBy });
  return ok({ restored });
}

// ─────────────────────────────────────────────────────────────────────────────
// Get change history for a doctor/hospital
// ─────────────────────────────────────────────────────────────────────────────

export async function getChangeLogs(
  hospitalId: string,
  doctorId?:  string,
  date?:      string,
): Promise<ServiceResponse<object[]>> {

  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (doctorId) where.doctor_id = doctorId;
  if (date)     where.date      = date;

  const logs = await SlotChangeLog.findAll({
    where,
    order: [['created_at', 'DESC']],
    limit: 100,
  });

  return ok(logs.map((l) => l.toJSON()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function findInvalidatedSlots(
  doctorId:    string,
  hospitalId:  string,
  date:        string,
  overrideType: OverrideType,
  startTime?:  string,
  endTime?:    string,
): Promise<OpdSlotSession[]> {

  const baseWhere: Record<string, unknown> = {
    doctor_id:   doctorId,
    hospital_id: hospitalId,
    date,
    status: { [Op.in]: [OpdSlotStatus.PUBLISHED, OpdSlotStatus.BOOKED] },
  };

  switch (overrideType) {
    case OverrideType.DAY_OFF:
      // All published/booked slots cancelled
      return OpdSlotSession.findAll({ where: baseWhere });

    case OverrideType.LATE_START:
      // Slots before the new start time are cancelled
      return OpdSlotSession.findAll({
        where: { ...baseWhere, slot_start_time: { [Op.lt]: startTime! } },
      });

    case OverrideType.EARLY_END:
      // Slots at or after the new end time are cancelled
      return OpdSlotSession.findAll({
        where: { ...baseWhere, slot_start_time: { [Op.gte]: endTime! } },
      });

    case OverrideType.BREAK:
      // Slots within the break window are cancelled
      return OpdSlotSession.findAll({
        where: {
          ...baseWhere,
          slot_start_time: { [Op.gte]: startTime!, [Op.lt]: endTime! },
        },
      });

    case OverrideType.RUNNING_LATE:
    case OverrideType.EXTRA_HOURS:
      // No cancellations — just notifications / additional slots
      return [];

    default:
      return [];
  }
}

async function cancelAppointmentForOverride(
  appointmentId: string,
  doctorId:      string,
  hospitalId:    string,
  date:          string,
  doctorName:    string,
  overrideType:  OverrideType,
  delayMinutes?: number,
): Promise<void> {
  const appointment = await Appointment.findByPk(appointmentId, {
    include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'] }],
  });
  if (!appointment) return;
  if (appointment.status === AppointmentStatus.CANCELLED) return;

  await appointment.update({
    status:              AppointmentStatus.CANCELLED,
    payment_status:      appointment.payment_status === PaymentStatus.CAPTURED ? PaymentStatus.REFUND_PENDING : appointment.payment_status,
    cancellation_reason: `Doctor ${overrideType.replace('_', ' ')} — auto-cancelled by system`,
    cancelled_by:        CancellationBy.DOCTOR,
    cancelled_at:        new Date(),
  });

  const notifType = overrideType === OverrideType.DAY_OFF ? 'doctor_absent' : 'booking_cancelled_doctor';
  const patientName = (appointment as any).patientProfile?.full_name ?? 'Patient';

  await enqueueNotification({
    userId:        appointment.patient_id,
    appointmentId: appointment.id,
    type:          notifType,
    channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
    priority:      'high',
    data: {
      name:   patientName,
      doctor: doctorName,
      date,
      hospital: hospitalId,
    },
  });
}

async function notifyRunningLate(
  doctorId:     string,
  hospitalId:   string,
  date:         string,
  delayMinutes: number,
  reason?:      string,
): Promise<number> {
  const doctor = await DoctorProfile.findByPk(doctorId, { attributes: ['full_name'] });
  const doctorName = doctor?.full_name ?? 'Doctor';

  // Find all booked appointments for this doctor today
  const start   = new Date(`${date}T00:00:00`);
  const end     = new Date(`${date}T23:59:59`);
  const booked  = await Appointment.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      scheduled_at: { [Op.between]: [start, end] },
      status: { [Op.in]: [AppointmentStatus.CONFIRMED, AppointmentStatus.PENDING, AppointmentStatus.AWAITING_HOSPITAL_APPROVAL] },
    },
    include: [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'] }],
  });

  for (const appt of booked) {
    const originalTime = appt.scheduled_at;
    const estimatedMs  = originalTime.getTime() + delayMinutes * 60 * 1000;
    const estimated    = new Date(estimatedMs);
    const estimatedTime = `${String(estimated.getHours()).padStart(2, '0')}:${String(estimated.getMinutes()).padStart(2, '0')}`;

    await enqueueNotification({
      userId:        appt.patient_id,
      appointmentId: appt.id,
      type:          'doctor_late',
      channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
      priority:      'high',
      data: {
        name:          (appt as any).patientProfile?.full_name ?? 'Patient',
        doctor:        doctorName,
        delay:         delayMinutes,
        time:          `${String(originalTime.getHours()).padStart(2, '0')}:${String(originalTime.getMinutes()).padStart(2, '0')}`,
        estimatedTime,
        token:         '—',
      },
    });
  }

  return booked.length;
}
