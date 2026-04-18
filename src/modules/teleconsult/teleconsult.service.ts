import { randomUUID }                    from 'crypto';
import { OpdSlotSession, SlotType, OpdSlotStatus } from '../../models';
import { ServiceResponse, ok, fail }     from '../../types';
import { enqueueNotification }           from '../notifications/notification.service';
import { NotificationChannel }           from '../../models';
import { env }                           from '../../config/env';
import { logger }                        from '../../utils/logger';

// ── Generate a unique video link for a slot ───────────────────────────────────

function generateVideoLink(slotId: string): string {
  const token = randomUUID().replace(/-/g, '').slice(0, 16);
  const base  = env.TELECONSULT_BASE_URL;
  return `${base}/room/${slotId.slice(0, 8)}-${token}`;
}

// ── Convert slot to teleconsult ───────────────────────────────────────────────

export async function convertToTeleconsult(
  slotId:       string,
  hospitalId:   string,
  requestedBy:  string,
): Promise<ServiceResponse<{ slot_id: string; slot_type: SlotType; video_link: string }>> {
  const slot = await OpdSlotSession.findOne({ where: { id: slotId, hospital_id: hospitalId } });
  if (!slot) return fail('SLOT_NOT_FOUND', 'Slot not found.', 404);
  if (slot.status === OpdSlotStatus.COMPLETED || slot.status === OpdSlotStatus.CANCELLED) {
    return fail('SLOT_INACTIVE', 'Cannot modify a completed or cancelled slot.', 409);
  }

  const videoLink = generateVideoLink(slotId);
  await slot.update({ slot_type: SlotType.TELECONSULT, video_link: videoLink });

  // Notify booked patient if applicable
  if (slot.appointment_id) {
    const { Appointment } = await import('../../models');
    const appt = await Appointment.findByPk(slot.appointment_id, { attributes: ['patient_id', 'scheduled_at'] });
    if (appt) {
      await enqueueNotification({
        userId:        appt.patient_id,
        appointmentId: slot.appointment_id,
        type:          'teleconsult_link',
        channels:      [NotificationChannel.SMS, NotificationChannel.PUSH],
        priority:      'high',
        data: {
          name:       'Patient',
          video_link: videoLink,
          date:       appt.scheduled_at.toDateString(),
          time:       appt.scheduled_at.toTimeString().slice(0, 5),
        },
      }).catch(() => { /* non-critical */ });
    }
  }

  logger.info('Slot converted to teleconsult', { slotId, requestedBy });
  return ok({ slot_id: slotId, slot_type: SlotType.TELECONSULT, video_link: videoLink });
}

// ── Set slot type (bulk — for a doctor+date) ──────────────────────────────────

export async function setSlotTypeForDate(input: {
  doctorId:    string;
  hospitalId:  string;
  date:        string;
  slotType:    SlotType;
  requestedBy: string;
}): Promise<ServiceResponse<{ updated: number }>> {
  const { doctorId, hospitalId, date, slotType, requestedBy } = input;

  const slots = await OpdSlotSession.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      date,
      status:      [OpdSlotStatus.DRAFT, OpdSlotStatus.PUBLISHED],
    },
    attributes: ['id'],
  });

  if (!slots.length) return fail('NO_SLOTS', 'No draft/published slots found for this date.', 404);

  let updated = 0;
  for (const slot of slots) {
    const videoLink = slotType === SlotType.IN_PERSON ? null : generateVideoLink(slot.id);
    await slot.update({ slot_type: slotType, video_link: videoLink });
    updated++;
  }

  logger.info('Slot types updated for date', { doctorId, hospitalId, date, slotType, updated, requestedBy });
  return ok({ updated });
}

// ── Get video link for a booked appointment ───────────────────────────────────

export async function getVideoLink(
  appointmentId: string,
  requesterId:   string,
): Promise<ServiceResponse<{ video_link: string; slot_type: SlotType }>> {
  const slot = await OpdSlotSession.findOne({
    where: { appointment_id: appointmentId },
    attributes: ['slot_type', 'video_link'],
  });

  if (!slot) return fail('SLOT_NOT_FOUND', 'No slot found for this appointment.', 404);
  if (slot.slot_type === SlotType.IN_PERSON || !slot.video_link) {
    return fail('NOT_TELECONSULT', 'This appointment is not a teleconsult.', 409);
  }

  return ok({ video_link: slot.video_link, slot_type: slot.slot_type });
}
