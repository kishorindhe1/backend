import { Op }                         from 'sequelize';
import {
  WaitlistEntry, WaitlistStatus,
  OpdSlotSession, OpdSlotStatus,
  Appointment, AppointmentStatus, PaymentStatus, CancellationBy,
  NoShowLog,
  GeneratedSlot, SlotStatus,
  DoctorProfile, Hospital,
}                                      from '../../models';
import { NotificationChannel }         from '../../models';
import { redis, RedisKeys }            from '../../config/redis';
import { enqueueNotification }         from '../notifications/notification.service';
import { ServiceResponse, ok, fail }   from '../../types';
import { logger }                      from '../../utils/logger';

const OFFER_WINDOW_MINUTES = 15;

// ── Join waitlist ─────────────────────────────────────────────────────────────

export async function joinWaitlist(
  patientId:          string,
  doctorId:           string,
  hospitalId:         string,
  date:               string,
  procedureTypeId?:   string,
  preferredStartTime?: string,
  preferredEndTime?:  string,
): Promise<ServiceResponse<{ entry_id: string; position: number }>> {

  // Prevent duplicate entries
  const existing = await WaitlistEntry.findOne({
    where: {
      patient_id:  patientId,
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      date,
      status:      { [Op.in]: [WaitlistStatus.WAITING, WaitlistStatus.OFFERED] },
    },
  });
  if (existing) return fail('ALREADY_ON_WAITLIST', 'You are already on the waitlist for this slot.', 409);

  // Next position
  const last = await WaitlistEntry.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date },
    order: [['position', 'DESC']],
  });
  const position = (last?.position ?? 0) + 1;

  const entry = await WaitlistEntry.create({
    patient_id:           patientId,
    doctor_id:            doctorId,
    hospital_id:          hospitalId,
    date,
    procedure_type_id:    procedureTypeId    ?? null,
    preferred_start_time: preferredStartTime ?? null,
    preferred_end_time:   preferredEndTime   ?? null,
    position,
    status:               WaitlistStatus.WAITING,
    offered_slot_id:      null,
    offered_at:           null,
    expires_at:           null,
  });

  logger.info('Joined waitlist', { patientId, doctorId, hospitalId, date, position });
  return ok({ entry_id: entry.id, position });
}

// ── Process waitlist when a slot opens ───────────────────────────────────────
// Called after cancellation, no-show, or any slot that returns to PUBLISHED.

export async function processWaitlist(
  doctorId:   string,
  hospitalId: string,
  date:       string,
  freedSlotId: string,
): Promise<void> {
  // Find next waiting patient
  const next = await WaitlistEntry.findOne({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date, status: WaitlistStatus.WAITING },
    order: [['position', 'ASC']],
  });

  if (!next) return;

  const now        = new Date();
  const expiresAt  = new Date(now.getTime() + OFFER_WINDOW_MINUTES * 60_000);

  await next.update({
    status:         WaitlistStatus.OFFERED,
    offered_slot_id: freedSlotId,
    offered_at:     now,
    expires_at:     expiresAt,
  });

  // Temporarily reserve the slot so others can't book it
  await OpdSlotSession.update(
    { status: OpdSlotStatus.RESERVED_EMERGENCY },
    { where: { id: freedSlotId } },
  );

  const doctor = await DoctorProfile.findByPk(doctorId, { attributes: ['full_name'] });

  await enqueueNotification({
    userId:  next.patient_id,
    type:    'waitlist_slot_available',
    channels:[NotificationChannel.SMS, NotificationChannel.PUSH],
    priority:'high',
    data: {
      doctor:     doctor?.full_name ?? 'Doctor',
      date,
      expires_in: `${OFFER_WINDOW_MINUTES} minutes`,
    },
  });

  logger.info('Waitlist offer sent', { patientId: next.patient_id, slotId: freedSlotId, expiresAt });
}

// ── Confirm a waitlist offer ──────────────────────────────────────────────────

export async function confirmWaitlistOffer(
  entryId:   string,
  patientId: string,
): Promise<ServiceResponse<{ slot_id: string; message: string }>> {

  const entry = await WaitlistEntry.findByPk(entryId);
  if (!entry) return fail('ENTRY_NOT_FOUND', 'Waitlist entry not found.', 404);
  if (entry.patient_id !== patientId) return fail('FORBIDDEN', 'Access denied.', 403);
  if (entry.status !== WaitlistStatus.OFFERED) return fail('OFFER_NOT_ACTIVE', 'No active offer for this entry.', 409);
  if (entry.expires_at && entry.expires_at < new Date()) {
    await entry.update({ status: WaitlistStatus.EXPIRED });
    return fail('OFFER_EXPIRED', 'The offer has expired. You have been removed from the waitlist.', 410);
  }

  const slotId = entry.offered_slot_id!;

  // Claim the slot
  await OpdSlotSession.update(
    { status: OpdSlotStatus.BOOKED },
    { where: { id: slotId } },
  );

  await entry.update({ status: WaitlistStatus.CONFIRMED });

  logger.info('Waitlist offer confirmed', { entryId, patientId, slotId });
  return ok({ slot_id: slotId, message: 'Slot confirmed from waitlist.' });
}

// ── Cancel a waitlist entry ───────────────────────────────────────────────────

export async function cancelWaitlistEntry(
  entryId:   string,
  patientId: string,
): Promise<ServiceResponse<{ message: string }>> {
  const entry = await WaitlistEntry.findByPk(entryId);
  if (!entry) return fail('ENTRY_NOT_FOUND', 'Waitlist entry not found.', 404);
  if (entry.patient_id !== patientId) return fail('FORBIDDEN', 'Access denied.', 403);
  if (entry.status === WaitlistStatus.CONFIRMED) return fail('ALREADY_CONFIRMED', 'Cannot cancel a confirmed waitlist entry.', 409);

  // If they had an active offer, release the slot back to PUBLISHED
  if (entry.status === WaitlistStatus.OFFERED && entry.offered_slot_id) {
    await OpdSlotSession.update(
      { status: OpdSlotStatus.PUBLISHED },
      { where: { id: entry.offered_slot_id } },
    );
    // Offer next person in line
    await processWaitlist(entry.doctor_id, entry.hospital_id, entry.date, entry.offered_slot_id);
  }

  await entry.update({ status: WaitlistStatus.CANCELLED });
  return ok({ message: 'Removed from waitlist.' });
}

// ── Get waitlist for a doctor/date ────────────────────────────────────────────

export async function getWaitlist(
  doctorId:   string,
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<object[]>> {
  const entries = await WaitlistEntry.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date },
    order: [['position', 'ASC']],
  });
  return ok(entries.map((e) => e.toJSON()));
}

// ── Get patient's own waitlist entries ───────────────────────────────────────

export async function getMyWaitlist(
  patientId: string,
  statuses?: WaitlistStatus[],
): Promise<ServiceResponse<object[]>> {
  const where: any = { patient_id: patientId };
  if (statuses?.length) where.status = { [Op.in]: statuses };

  const entries = await WaitlistEntry.findAll({
    where,
    order: [['created_at', 'DESC']],
    include: [
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name', 'specialization'] },
      { model: Hospital,      as: 'hospital', attributes: ['name'] },
    ],
  });

  // Resolve offered_slot details separately for OFFERED entries
  const results = await Promise.all(
    entries.map(async (e) => {
      const json: any = { ...e.toJSON(), offer_expires_at: e.expires_at };
      if (e.status === WaitlistStatus.OFFERED && e.offered_slot_id) {
        const slot = await OpdSlotSession.findByPk(e.offered_slot_id, {
          attributes: ['slot_datetime', 'duration_minutes'],
        });
        if (slot) json.offered_slot = slot.toJSON();
      }
      return json;
    }),
  );

  return ok(results);
}

// ── Expire stale offers (cron) ────────────────────────────────────────────────

export async function expireWaitlistOffers(): Promise<{ expired: number; reoffered: number }> {
  const now   = new Date();

  const stale = await WaitlistEntry.findAll({
    where: { status: WaitlistStatus.OFFERED, expires_at: { [Op.lt]: now } },
  });

  let expired   = 0;
  let reoffered = 0;

  for (const entry of stale) {
    await entry.update({ status: WaitlistStatus.EXPIRED });
    expired++;

    // Release the slot back and offer next person
    if (entry.offered_slot_id) {
      await OpdSlotSession.update(
        { status: OpdSlotStatus.PUBLISHED },
        { where: { id: entry.offered_slot_id } },
      );
      await processWaitlist(entry.doctor_id, entry.hospital_id, entry.date, entry.offered_slot_id);
      reoffered++;
    }
  }

  if (expired > 0) logger.info('Waitlist offers expired', { expired, reoffered });
  return { expired, reoffered };
}

// ── Mark no-show ──────────────────────────────────────────────────────────────

export async function markNoShow(
  appointmentId: string,
  markedBy:      string,
  gracePeriodMinutes = 15,
): Promise<ServiceResponse<{ message: string; waitlist_offered: boolean }>> {
  const appointment = await Appointment.findByPk(appointmentId);
  if (!appointment) return fail('NOT_FOUND', 'Appointment not found.', 404);
  if (appointment.status === AppointmentStatus.CANCELLED) return fail('ALREADY_CANCELLED', 'Appointment already cancelled.', 409);
  if (appointment.status === AppointmentStatus.COMPLETED) return fail('ALREADY_COMPLETED', 'Appointment already completed.', 409);

  // Cancel appointment (no refund for no-show)
  await appointment.update({
    status:              AppointmentStatus.CANCELLED,
    cancellation_reason: 'Patient no-show',
    cancelled_by:        CancellationBy.SYSTEM,
    cancelled_at:        new Date(),
  });

  // Log no-show
  await NoShowLog.create({
    appointment_id:       appointmentId,
    patient_id:           appointment.patient_id,
    doctor_id:            appointment.doctor_id,
    slot_id:              appointment.slot_id ?? null,
    grace_period_minutes: gracePeriodMinutes,
    marked_by:            markedBy,
  });

  // Free the GeneratedSlot
  if (appointment.slot_id) {
    await GeneratedSlot.update(
      { status: SlotStatus.AVAILABLE, appointment_id: null },
      { where: { id: appointment.slot_id } },
    );
  }

  // Find and free the OpdSlotSession
  const date = appointment.scheduled_at.toISOString().split('T')[0];
  const hhmm = `${String(appointment.scheduled_at.getHours()).padStart(2, '0')}:${String(appointment.scheduled_at.getMinutes()).padStart(2, '0')}`;

  const opdSlot = await OpdSlotSession.findOne({
    where: {
      doctor_id:       appointment.doctor_id,
      hospital_id:     appointment.hospital_id,
      date,
      slot_start_time: hhmm,
      status:          OpdSlotStatus.BOOKED,
    },
  });

  let waitlistOffered = false;
  if (opdSlot) {
    await opdSlot.update({ status: OpdSlotStatus.PUBLISHED, appointment_id: null });

    // Offer to next waitlist patient
    const before = await WaitlistEntry.count({
      where: { doctor_id: appointment.doctor_id, hospital_id: appointment.hospital_id, date, status: WaitlistStatus.WAITING },
    });
    if (before > 0) {
      await processWaitlist(appointment.doctor_id, appointment.hospital_id, date, opdSlot.id);
      waitlistOffered = true;
    }
  }

  // Invalidate caches
  await redis.del(RedisKeys.availableSlots(appointment.doctor_id, date));
  await redis.del(RedisKeys.publishedSlots(appointment.doctor_id, date));

  logger.info('No-show marked', { appointmentId, markedBy, waitlistOffered });
  return ok({ message: 'Patient marked as no-show. Slot freed.', waitlist_offered: waitlistOffered });
}
