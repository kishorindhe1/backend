import { Op } from 'sequelize';
import { Schedule, DayOfWeek }        from '../../models';
import { GeneratedSlot, SlotStatus }  from '../../models';
import { OpdSlotSession, OpdSlotStatus } from '../../models';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import { ServiceResponse, ok, fail }  from '../../types';
import { logger }                     from '../../utils/logger';

// ── Day-of-week helpers ───────────────────────────────────────────────────────
const JS_DAY_TO_ENUM: DayOfWeek[] = [
  DayOfWeek.SUNDAY, DayOfWeek.MONDAY, DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY,
];

function parseTime(timeStr: string, baseDate: Date): Date {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const d = new Date(baseDate);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

// ── List schedules for a doctor at a hospital ─────────────────────────────────
export async function listSchedules(
  doctorId: string,
  hospitalId: string,
): Promise<ServiceResponse<object[]>> {
  const schedules = await Schedule.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId },
    order: [['day_of_week', 'ASC'], ['start_time', 'ASC']],
  });
  return ok(schedules.map((s) => s.toJSON()));
}

// ── Generate slots for a doctor between from_date and to_date ─────────────────
export async function generateSlotsForDoctor(
  doctorId: string,
  hospitalId: string,
  fromDate: string,  // YYYY-MM-DD
  toDate: string,    // YYYY-MM-DD
): Promise<ServiceResponse<{ generated: number; skipped: number }>> {
  const schedules = await Schedule.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });

  if (!schedules.length) {
    return fail('SCHEDULE_NOT_FOUND', 'No active schedule found for this doctor.', 404);
  }

  const start = new Date(`${fromDate}T00:00:00`);
  const end   = new Date(`${toDate}T00:00:00`);

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
    return fail('INVALID_DATE_RANGE', 'from_date must be a valid date on or before to_date.', 400);
  }

  let generated = 0;
  let skipped   = 0;

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const targetDate = new Date(d);

    const dayEnum = JS_DAY_TO_ENUM[targetDate.getDay()];

    // Find schedules for this day of week
    const daySchedules = schedules.filter(
      (s) => s.day_of_week === dayEnum &&
             new Date(s.effective_from) <= targetDate &&
             (!s.effective_until || new Date(s.effective_until) >= targetDate),
    );

    for (const schedule of daySchedules) {
      const startTime = parseTime(schedule.start_time, targetDate);
      const endTime   = parseTime(schedule.end_time,   targetDate);
      const slotMs    = schedule.slot_duration_minutes * 60 * 1000;

      let current = new Date(startTime);
      let count   = 0;

      while (current < endTime && count < schedule.max_patients) {
        // Skip past slots
        if (current <= new Date()) {
          current = new Date(current.getTime() + slotMs);
          count++;
          continue;
        }

        try {
          await GeneratedSlot.create({
            doctor_id:        doctorId,
            hospital_id:      hospitalId,
            schedule_id:      schedule.id,
            slot_datetime:    new Date(current),
            duration_minutes: schedule.slot_duration_minutes,
            status:           SlotStatus.AVAILABLE,
            appointment_id:   null,
            blocked_reason:   null,
          });
          generated++;
        } catch (err: unknown) {
          // Unique constraint violation = slot already exists — skip silently
          if ((err as { name?: string }).name === 'SequelizeUniqueConstraintError') {
            skipped++;
          } else {
            throw err;
          }
        }

        current = new Date(current.getTime() + slotMs);
        count++;
      }
    }
  }

  // Invalidate slot cache for this doctor
  await redis.del(RedisKeys.doctorSchedule(doctorId));

  logger.info('Slots generated', { doctorId, hospitalId, generated, skipped });
  return ok({ generated, skipped });
}

// ── Get available slots for a doctor on a given date ─────────────────────────
// Phase 3: reads from OpdSlotSession (PUBLISHED) as primary source when available.
// Cross-references GeneratedSlot by time to return a compatible slot_id for booking.
// Falls back to GeneratedSlot when no governance-published slots exist.
export async function getAvailableSlots(
  doctorId: string,
  hospitalId: string,
  date: string,  // YYYY-MM-DD
): Promise<ServiceResponse<object[]>> {
  const cacheKey = RedisKeys.availableSlots(doctorId, date);
  const cached   = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached));

  // ── Primary: governance-published slots ────────────────────────────────────
  const publishedSessions = await OpdSlotSession.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date, status: OpdSlotStatus.PUBLISHED },
    order: [['slot_start_time', 'ASC']],
  });

  if (publishedSessions.length > 0) {
    // Cross-reference with GeneratedSlot (match by time HH:MM) for booking compat
    const dayStart = new Date(`${date}T00:00:00.000Z`);
    const dayEnd   = new Date(`${date}T23:59:59.999Z`);

    const generatedSlots = await GeneratedSlot.findAll({
      where: {
        doctor_id:     doctorId,
        hospital_id:   hospitalId,
        status:        SlotStatus.AVAILABLE,
        slot_datetime: { [Op.between]: [dayStart, dayEnd] },
      },
    });

    // Build time→GeneratedSlot.id map (HH:MM → id)
    const genByTime = new Map<string, string>();
    for (const gs of generatedSlots) {
      const hhmm = `${String(gs.slot_datetime.getUTCHours()).padStart(2, '0')}:${String(gs.slot_datetime.getUTCMinutes()).padStart(2, '0')}`;
      genByTime.set(hhmm, gs.id);
    }

    const result = publishedSessions.map((s) => {
      const generatedSlotId = genByTime.get(s.slot_start_time);
      if (!generatedSlotId) {
        logger.warn('Phase3: published OpdSlotSession has no matching GeneratedSlot', {
          doctorId, hospitalId, date, slot_start_time: s.slot_start_time,
        });
      }
      return {
        slot_id:          generatedSlotId ?? s.id,  // fallback to OpdSlotSession.id if no match
        opd_slot_id:      s.id,
        date:             s.date,
        slot_start_time:  s.slot_start_time,
        slot_end_time:    s.slot_end_time,
        duration_minutes: s.duration_minutes,
        slot_category:    s.slot_category,
        status:           s.status,
        source:           generatedSlotId ? 'governance' : 'governance_only',
      };
    });

    // Validate coverage — log GeneratedSlots missing from OpdSlotSession
    const publishedTimes = new Set(publishedSessions.map((s) => s.slot_start_time));
    for (const gs of generatedSlots) {
      const hhmm = `${String(gs.slot_datetime.getUTCHours()).padStart(2, '0')}:${String(gs.slot_datetime.getUTCMinutes()).padStart(2, '0')}`;
      if (!publishedTimes.has(hhmm)) {
        logger.warn('Phase3: GeneratedSlot not in published OpdSlotSession (discrepancy)', {
          doctorId, hospitalId, date, hhmm, generatedSlotId: gs.id,
        });
      }
    }

    await redis.setex(cacheKey, RedisTTL.AVAILABLE_SLOTS, JSON.stringify(result));
    return ok(result);
  }

  // ── Fallback: legacy GeneratedSlot path ────────────────────────────────────
  logger.info('Phase3: no published governance slots — falling back to GeneratedSlot', { doctorId, hospitalId, date });

  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd   = new Date(`${date}T23:59:59.999Z`);

  const slots = await GeneratedSlot.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      status:      SlotStatus.AVAILABLE,
      slot_datetime: { [Op.between]: [dayStart, dayEnd] },
    },
    order: [['slot_datetime', 'ASC']],
  });

  const result = slots.map((s) => ({
    slot_id:          s.id,
    opd_slot_id:      null,
    slot_datetime:    s.slot_datetime,
    duration_minutes: s.duration_minutes,
    status:           s.status,
    source:           'legacy',
  }));

  await redis.setex(cacheKey, RedisTTL.AVAILABLE_SLOTS, JSON.stringify(result));
  return ok(result);
}

// ── Get ALL slots for admin view (all statuses) ───────────────────────────────
export async function getAllSlotsForAdmin(
  doctorId: string,
  hospitalId: string,
  date: string,
): Promise<ServiceResponse<object[]>> {
  const dayStart = new Date(`${date}T00:00:00.000Z`);
  const dayEnd   = new Date(`${date}T23:59:59.999Z`);

  const slots = await GeneratedSlot.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      slot_datetime: { [Op.between]: [dayStart, dayEnd] },
    },
    order: [['slot_datetime', 'ASC']],
  });

  return ok(slots.map((s) => ({
    slot_id:          s.id,
    slot_datetime:    s.slot_datetime,
    duration_minutes: s.duration_minutes,
    status:           s.status,
    blocked_reason:   s.blocked_reason,
  })));
}

// ── Unblock a slot ────────────────────────────────────────────────────────────
export async function unblockSlot(
  slotId: string,
): Promise<ServiceResponse<{ message: string }>> {
  const slot = await GeneratedSlot.findByPk(slotId);
  if (!slot) return fail('SLOT_NOT_FOUND', 'Slot not found.', 404);

  if (slot.status !== SlotStatus.BLOCKED) {
    return fail('SLOT_NOT_BLOCKED', `Slot is not blocked (status: ${slot.status}).`, 409);
  }

  await slot.update({ status: SlotStatus.AVAILABLE, blocked_reason: null });
  await redis.del(RedisKeys.availableSlots(slot.doctor_id, slot.slot_datetime.toISOString().split('T')[0]));

  return ok({ message: 'Slot unblocked successfully.' });
}

// ── Deactivate a schedule ─────────────────────────────────────────────────────
export async function deactivateSchedule(
  scheduleId: string,
): Promise<ServiceResponse<{ message: string }>> {
  const schedule = await Schedule.findByPk(scheduleId);
  if (!schedule) return fail('SCHEDULE_NOT_FOUND', 'Schedule not found.', 404);
  if (!schedule.is_active) return fail('ALREADY_INACTIVE', 'Schedule is already inactive.', 409);

  await schedule.update({ is_active: false });
  await redis.del(RedisKeys.doctorSchedule(schedule.doctor_id));

  logger.info('Schedule deactivated', { scheduleId });
  return ok({ message: 'Schedule deactivated successfully.' });
}

// ── Block a slot (doctor leave, holiday) ─────────────────────────────────────
export async function blockSlot(
  slotId: string,
  reason: string,
): Promise<ServiceResponse<{ message: string }>> {
  const slot = await GeneratedSlot.findByPk(slotId);
  if (!slot) return fail('SLOT_NOT_FOUND', 'Slot not found.', 404);

  if (slot.status !== SlotStatus.AVAILABLE) {
    return fail('SLOT_NOT_AVAILABLE', `Slot is already ${slot.status}.`, 409);
  }

  await slot.update({ status: SlotStatus.BLOCKED, blocked_reason: reason });
  await redis.del(RedisKeys.availableSlots(slot.doctor_id, slot.slot_datetime.toISOString().split('T')[0]));

  return ok({ message: 'Slot blocked successfully.' });
}
