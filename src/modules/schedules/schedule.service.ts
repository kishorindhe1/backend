import { Op } from 'sequelize';
import { Schedule, DayOfWeek }   from '../../models';
import { GeneratedSlot, SlotStatus } from '../../models';
import { DoctorProfile }         from '../../models';
import { redis, RedisKeys, RedisTTL } from '../../config/redis';
import { ServiceResponse, ok, fail }  from '../../types';
import { logger }                from '../../utils/logger';

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
export async function getAvailableSlots(
  doctorId: string,
  hospitalId: string,
  date: string,  // YYYY-MM-DD
): Promise<ServiceResponse<object[]>> {
  const cacheKey = RedisKeys.availableSlots(doctorId, date);
  const cached   = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached));

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
    slot_datetime:    s.slot_datetime,
    duration_minutes: s.duration_minutes,
    status:           s.status,
  }));

  await redis.setex(cacheKey, RedisTTL.AVAILABLE_SLOTS, JSON.stringify(result));
  return ok(result);
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
