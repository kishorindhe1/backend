import {
  DoctorBookingPreference,
  DoctorHospitalAffiliation,
  SlotAutonomyLevel,
}                                    from '../../models';
import { ServiceResponse, ok, fail } from '../../types';

// ── Get preferences (or defaults if none set) ─────────────────────────────────

export async function getPreferences(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<object>> {
  let pref = await DoctorBookingPreference.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId },
  });

  if (!pref) {
    // Return schema defaults — not persisted until first upsert
    return ok({
      doctor_id:                  doctorId,
      hospital_id:                hospitalId,
      min_booking_lead_hours:     0,
      booking_cutoff_hours:       0,
      max_new_patients_per_day:   null,
      max_followups_per_day:      null,
      new_patient_slot_positions: null,
      followup_slot_positions:    null,
      requires_booking_approval:  false,
      approval_timeout_hours:     2,
      default_slot_duration:      null,
      notes_for_patients:         null,
      persisted:                  false,
    });
  }

  return ok({ ...pref.toJSON(), persisted: true });
}

// ── Upsert preferences ────────────────────────────────────────────────────────

export type UpsertPreferencesInput = {
  min_booking_lead_hours?:     number;
  booking_cutoff_hours?:       number;
  max_new_patients_per_day?:   number | null;
  max_followups_per_day?:      number | null;
  new_patient_slot_positions?: number[] | null;
  followup_slot_positions?:    number[] | null;
  requires_booking_approval?:  boolean;
  approval_timeout_hours?:     number;
  default_slot_duration?:      number | null;
  notes_for_patients?:         string | null;
};

export async function upsertPreferences(
  doctorId:   string,
  hospitalId: string,
  input:      UpsertPreferencesInput,
): Promise<ServiceResponse<object>> {
  const aff = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });
  if (!aff) return fail('NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.', 404);

  const [pref] = await DoctorBookingPreference.upsert({
    doctor_id:  doctorId,
    hospital_id: hospitalId,
    ...input,
  });

  return ok(pref.toJSON());
}

// ── Get autonomy level ────────────────────────────────────────────────────────

export async function getAutonomyLevel(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<{ doctor_id: string; hospital_id: string; slot_autonomy_level: SlotAutonomyLevel; employment_type: string }>> {
  const aff = await DoctorHospitalAffiliation.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
    attributes: ['doctor_id', 'hospital_id', 'slot_autonomy_level', 'employment_type'],
  });
  if (!aff) return fail('NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.', 404);
  return ok({
    doctor_id:           aff.doctor_id,
    hospital_id:         aff.hospital_id,
    slot_autonomy_level: aff.slot_autonomy_level,
    employment_type:     aff.employment_type,
  });
}

// ── Update autonomy level ─────────────────────────────────────────────────────

export async function updateAutonomyLevel(
  doctorId:   string,
  hospitalId: string,
  level:      SlotAutonomyLevel,
): Promise<ServiceResponse<{ slot_autonomy_level: SlotAutonomyLevel }>> {
  const [affected] = await DoctorHospitalAffiliation.update(
    { slot_autonomy_level: level },
    { where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true } },
  );
  if (!affected) return fail('NOT_AFFILIATED', 'Doctor is not affiliated with this hospital.', 404);
  return ok({ slot_autonomy_level: level });
}
