import { Op } from 'sequelize';
import { sequelize }                    from '../../config/database';
import {
  PatientDoctorDuration,
  PatientDoctorDurationHistory,
  DoctorProfile,
}                                       from '../../models';
import { ErrorFactory }                 from '../../utils/errors';
import { ServiceResponse, ok }          from '../../types';

const DEFAULT_DURATION_MINUTES = 15;

// ── Get effective duration for a patient+doctor pair ──────────────────────────
// Returns personalized duration if set, else doctor's default, else system default.
export async function getEffectiveDuration(
  patientId: string,
  doctorId:  string,
  overrideMinutes?: number,
): Promise<number> {
  if (overrideMinutes != null) return overrideMinutes;

  const [record, doctor] = await Promise.all([
    PatientDoctorDuration.findOne({ where: { patient_id: patientId, doctor_id: doctorId } }),
    DoctorProfile.findByPk(doctorId, { attributes: ['avg_consultation_minutes'] }),
  ]);

  if (record) return record.duration_minutes;
  if (doctor?.avg_consultation_minutes) return Number(doctor.avg_consultation_minutes);
  return DEFAULT_DURATION_MINUTES;
}

// ── Set / update duration after a consultation ────────────────────────────────
export interface SetDurationInput {
  patient_id:      string;
  doctor_id:       string;
  duration_minutes: number;
  set_by_user_id:  string;
  set_by_role:     'doctor' | 'receptionist';
  notes?:          string;
}

export async function setDuration(input: SetDurationInput): Promise<ServiceResponse<PatientDoctorDuration>> {
  return sequelize.transaction(async (t) => {
    const existing = await PatientDoctorDuration.findOne({
      where: { patient_id: input.patient_id, doctor_id: input.doctor_id },
      transaction: t,
    });

    if (existing) {
      // Log the change before updating
      await PatientDoctorDurationHistory.create({
        patient_doctor_duration_id: existing.id,
        old_duration:               existing.duration_minutes,
        new_duration:               input.duration_minutes,
        changed_by_user_id:         input.set_by_user_id,
        changed_by_role:            input.set_by_role,
        changed_at:                 new Date(),
        reason:                     input.notes ?? null,
      }, { transaction: t });

      await existing.update({
        duration_minutes: input.duration_minutes,
        set_by_user_id:   input.set_by_user_id,
        set_by_role:      input.set_by_role,
        set_at:           new Date(),
        notes:            input.notes ?? null,
      }, { transaction: t });

      return ok(existing);
    }

    const created = await PatientDoctorDuration.create({
      patient_id:       input.patient_id,
      doctor_id:        input.doctor_id,
      duration_minutes: input.duration_minutes,
      set_by_user_id:   input.set_by_user_id,
      set_by_role:      input.set_by_role,
      set_at:           new Date(),
      notes:            input.notes ?? null,
    }, { transaction: t });

    return ok(created);
  });
}

// ── Record a one-time override (does NOT update stored duration) ──────────────
// Called when a receptionist extends a single visit duration without changing the stored record.
export async function recordOneTimeOverride(
  patientId:       string,
  doctorId:        string,
  overrideMinutes: number,
  changedByUserId: string,
  changedByRole:   string,
  reason:          string,
): Promise<void> {
  const existing = await PatientDoctorDuration.findOne({
    where: { patient_id: patientId, doctor_id: doctorId },
  });

  if (existing) {
    await PatientDoctorDurationHistory.create({
      patient_doctor_duration_id: existing.id,
      old_duration:               existing.duration_minutes,
      new_duration:               overrideMinutes,
      changed_by_user_id:         changedByUserId,
      changed_by_role:            changedByRole,
      changed_at:                 new Date(),
      reason,
    });
  }
  // If no record exists yet, nothing to log — the override is ephemeral
}

// ── Get duration history for a patient+doctor pair ────────────────────────────
export async function getDurationHistory(
  patientId: string,
  doctorId:  string,
): Promise<ServiceResponse<{ current: PatientDoctorDuration | null; history: PatientDoctorDurationHistory[] }>> {
  const record = await PatientDoctorDuration.findOne({
    where: { patient_id: patientId, doctor_id: doctorId },
    include: [{ model: PatientDoctorDurationHistory, as: 'history', order: [['changed_at', 'DESC']] }],
  });

  return ok({
    current: record ?? null,
    history: (record?.get('history') as PatientDoctorDurationHistory[]) ?? [],
  });
}
