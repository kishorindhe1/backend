import { Op }                       from 'sequelize';
import {
  SlotTemplate, TemplateAppliesTo,
  OpdSlotSession, OpdSlotStatus,
  DoctorHospitalAffiliation,
  DoctorProfile,
}                                    from '../../models';
import { ServiceResponse, ok, fail } from '../../types';
import { logger }                    from '../../utils/logger';

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function listTemplates(
  hospitalId: string,
): Promise<ServiceResponse<object[]>> {
  const templates = await SlotTemplate.findAll({
    where: { hospital_id: hospitalId },
    order: [['name', 'ASC']],
  });
  return ok(templates.map((t) => t.toJSON()));
}

export async function createTemplate(payload: {
  hospital_id:              string;
  name:                     string;
  applies_to:               TemplateAppliesTo;
  doctor_ids?:              string[];
  specialisation?:          string;
  day_of_week?:             string;
  override_start_time?:     string;
  override_end_time?:       string;
  capacity_percent?:        number;
  emergency_reserve_slots?: number;
  notes?:                   string;
  created_by:               string;
}): Promise<ServiceResponse<object>> {
  const tmpl = await SlotTemplate.create({
    hospital_id:              payload.hospital_id,
    name:                     payload.name,
    applies_to:               payload.applies_to,
    doctor_ids:               payload.doctor_ids ? payload.doctor_ids : null,
    specialisation:           payload.specialisation  ?? null,
    day_of_week:              (payload.day_of_week as any) ?? null,
    override_start_time:      payload.override_start_time  ?? null,
    override_end_time:        payload.override_end_time    ?? null,
    capacity_percent:         payload.capacity_percent         ?? 100,
    emergency_reserve_slots:  payload.emergency_reserve_slots  ?? 1,
    notes:                    payload.notes ?? null,
    created_by:               payload.created_by,
  });
  return ok(tmpl.toJSON());
}

export async function deleteTemplate(
  templateId: string,
  hospitalId: string,
): Promise<ServiceResponse<{ message: string }>> {
  const tmpl = await SlotTemplate.findOne({ where: { id: templateId, hospital_id: hospitalId } });
  if (!tmpl) return fail('NOT_FOUND', 'Template not found.', 404);
  await tmpl.destroy();
  return ok({ message: 'Template deleted.' });
}

// ── Apply template to a draft ─────────────────────────────────────────────────
// Applies capacity restrictions and emergency reserve adjustments to DRAFT slots
// for a given hospital + date. Excess slots above capacity_percent are cancelled.

export async function applyTemplate(
  templateId: string,
  hospitalId: string,
  date:       string,
  appliedBy:  string,
): Promise<ServiceResponse<{ modified: number; cancelled: number }>> {

  const tmpl = await SlotTemplate.findOne({ where: { id: templateId, hospital_id: hospitalId } });
  if (!tmpl) return fail('NOT_FOUND', 'Template not found.', 404);

  // Determine target doctors
  let doctorIds: string[];

  if (tmpl.applies_to === TemplateAppliesTo.ALL_DOCTORS) {
    const affs = await DoctorHospitalAffiliation.findAll({
      where: { hospital_id: hospitalId, is_active: true },
      attributes: ['doctor_id'],
    });
    doctorIds = affs.map((a) => a.doctor_id);
  } else if (tmpl.applies_to === TemplateAppliesTo.SPECIFIC_DOCTORS) {
    doctorIds = (tmpl.doctor_ids as string[]) ?? [];
  } else {
    // by specialisation
    const docs = await DoctorProfile.findAll({
      where: { specialization: tmpl.specialisation ?? '' },
      attributes: ['id'],
    });
    const docIds = docs.map((d) => d.id);
    const affs = await DoctorHospitalAffiliation.findAll({
      where: { hospital_id: hospitalId, doctor_id: { [Op.in]: docIds }, is_active: true },
      attributes: ['doctor_id'],
    });
    doctorIds = affs.map((a) => a.doctor_id);
  }

  let totalModified = 0;
  let totalCancelled = 0;

  for (const doctorId of doctorIds) {
    const drafts = await OpdSlotSession.findAll({
      where: { doctor_id: doctorId, hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT },
      order: [['slot_start_time', 'ASC']],
    });

    if (!drafts.length) continue;

    // Apply capacity_percent — keep only the first N slots
    const keepCount = Math.ceil(drafts.length * (tmpl.capacity_percent / 100));
    const toCancel  = drafts.slice(keepCount);

    for (const slot of toCancel) {
      await slot.update({ status: OpdSlotStatus.CANCELLED, blocked_reason: `Template: ${tmpl.name}` });
      totalCancelled++;
    }

    // Apply override times — shift remaining draft slots window if specified
    if (tmpl.override_start_time || tmpl.override_end_time) {
      const keep = drafts.slice(0, keepCount);
      for (const slot of keep) {
        if (tmpl.override_start_time && slot.slot_start_time < tmpl.override_start_time) {
          await slot.update({ status: OpdSlotStatus.CANCELLED, blocked_reason: `Before template start ${tmpl.override_start_time}` });
          totalCancelled++;
          continue;
        }
        if (tmpl.override_end_time && slot.slot_start_time >= tmpl.override_end_time) {
          await slot.update({ status: OpdSlotStatus.CANCELLED, blocked_reason: `After template end ${tmpl.override_end_time}` });
          totalCancelled++;
          continue;
        }
        totalModified++;
      }
    } else {
      totalModified += keepCount;
    }
  }

  logger.info('Template applied', { templateId, hospitalId, date, totalModified, totalCancelled, appliedBy });
  return ok({ modified: totalModified, cancelled: totalCancelled });
}
