import { Schedule, DayOfWeek }           from '../../models';
import { OpdSlotSession, OpdSlotStatus } from '../../models';
import { redis, RedisKeys, RedisTTL }    from '../../config/redis';
import { ServiceResponse, ok, fail }     from '../../types';
import { logger }                        from '../../utils/logger';

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

// ── Get available slots for a doctor on a given date ─────────────────────────
export async function getAvailableSlots(
  doctorId: string,
  hospitalId: string,
  date: string,  // YYYY-MM-DD
): Promise<ServiceResponse<object[]>> {
  const cacheKey = RedisKeys.publishedSlots(doctorId, date);
  const cached   = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached));

  const slots = await OpdSlotSession.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date, status: OpdSlotStatus.PUBLISHED },
    order: [['slot_start_time', 'ASC']],
  });

  const result = slots.map((s) => ({
    slot_id:          s.id,
    date:             s.date,
    slot_start_time:  s.slot_start_time,
    slot_end_time:    s.slot_end_time,
    duration_minutes: s.duration_minutes,
    slot_category:    s.slot_category,
    status:           s.status,
  }));

  await redis.setex(cacheKey, RedisTTL.PUBLISHED_SLOTS, JSON.stringify(result));
  return ok(result);
}

// ── Get ALL slots for admin view (all statuses) ───────────────────────────────
export async function getAllSlotsForAdmin(
  doctorId: string,
  hospitalId: string,
  date: string,
): Promise<ServiceResponse<object[]>> {
  const slots = await OpdSlotSession.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date },
    order: [['slot_start_time', 'ASC']],
  });

  return ok(slots.map((s) => ({
    slot_id:          s.id,
    slot_start_time:  s.slot_start_time,
    slot_end_time:    s.slot_end_time,
    duration_minutes: s.duration_minutes,
    status:           s.status,
    blocked_reason:   s.blocked_reason,
  })));
}

// ── Unblock a slot ────────────────────────────────────────────────────────────
export async function unblockSlot(
  slotId: string,
): Promise<ServiceResponse<{ message: string }>> {
  const slot = await OpdSlotSession.findByPk(slotId);
  if (!slot) return fail('SLOT_NOT_FOUND', 'Slot not found.', 404);

  if (slot.status !== OpdSlotStatus.BLOCKED) {
    return fail('SLOT_NOT_BLOCKED', `Slot is not blocked (status: ${slot.status}).`, 409);
  }

  await slot.update({ status: OpdSlotStatus.PUBLISHED, blocked_reason: null });
  await redis.del(RedisKeys.publishedSlots(slot.doctor_id, slot.date));

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
  const slot = await OpdSlotSession.findByPk(slotId);
  if (!slot) return fail('SLOT_NOT_FOUND', 'Slot not found.', 404);

  if (slot.status !== OpdSlotStatus.PUBLISHED) {
    return fail('SLOT_NOT_AVAILABLE', `Slot is already ${slot.status}.`, 409);
  }

  await slot.update({ status: OpdSlotStatus.BLOCKED, blocked_reason: reason });
  await redis.del(RedisKeys.publishedSlots(slot.doctor_id, slot.date));

  return ok({ message: 'Slot blocked successfully.' });
}
