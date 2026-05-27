import { Op }                                         from 'sequelize';
import { Schedule, DayOfWeek, OpdBookingModeConfig } from '../../models';
import type { SessionsConfig } from '../../models';
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
  const nowIST         = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayIST       = nowIST.toISOString().split('T')[0];
  const currentTimeIST = `${String(nowIST.getUTCHours()).padStart(2,'0')}:${String(nowIST.getUTCMinutes()).padStart(2,'0')}`;

  if (date < todayIST) return ok([]);

  // Skip cache for today — slot availability changes minute-by-minute as time passes
  const isToday  = date === todayIST;
  const cacheKey = RedisKeys.publishedSlots(doctorId, date);

  if (!isToday) {
    const cached = await redis.get(cacheKey);
    if (cached) return ok(JSON.parse(cached));
  }

  const where: Record<string, unknown> = {
    doctor_id:   doctorId,
    hospital_id: hospitalId,
    date,
    status:      OpdSlotStatus.PUBLISHED,
  };
  if (isToday) where.slot_start_time = { [Op.gt]: currentTimeIST };

  const slots = await OpdSlotSession.findAll({ where, order: [['slot_start_time', 'ASC']] });

  const result = slots.map((s) => ({
    slot_id:          s.id,
    date:             s.date,
    slot_start_time:  s.slot_start_time,
    slot_end_time:    s.slot_end_time,
    duration_minutes: s.duration_minutes,
    slot_category:    s.slot_category,
    status:           s.status,
  }));

  if (!isToday) await redis.setex(cacheKey, RedisTTL.PUBLISHED_SLOTS, JSON.stringify(result));
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
    slot_datetime:    `${s.date}T${s.slot_start_time}:00`,
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

// ── Configure queue-based booking on a schedule ───────────────────────────────
// Admin sets opd_booking_mode to token_based and defines session layout.
export async function updateQueueConfig(
  scheduleId:    string,
  opdBookingMode: OpdBookingModeConfig,
  sessionsConfig: SessionsConfig | null,
): Promise<ServiceResponse<object>> {
  const schedule = await Schedule.findByPk(scheduleId);
  if (!schedule) return fail('SCHEDULE_NOT_FOUND', 'Schedule not found.', 404);

  if (opdBookingMode === OpdBookingModeConfig.TOKEN_BASED && sessionsConfig) {
    for (const s of sessionsConfig.sessions) {
      if (s.max_patients < 1) {
        return fail('INVALID_SESSIONS_CONFIG', `Session "${s.name}": max_patients must be at least 1.`, 422);
      }
    }
  }

  await schedule.update({
    opd_booking_mode: opdBookingMode,
    sessions_config:  opdBookingMode === OpdBookingModeConfig.TOKEN_BASED ? (sessionsConfig ?? null) : null,
  });

  await redis.del(RedisKeys.doctorSchedule(schedule.doctor_id));
  logger.info('Schedule queue config updated', { scheduleId, opdBookingMode });
  return ok(schedule.toJSON());
}

// ── Generate slots from schedule config for a date range ─────────────────────
export async function generateSlots(
  doctorId:   string,
  hospitalId: string,
  fromDate:   string,  // YYYY-MM-DD
  toDate:     string,  // YYYY-MM-DD
): Promise<ServiceResponse<{ generated: number }>> {
  const schedules = await Schedule.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });

  if (!schedules.length) {
    return fail('NO_SCHEDULES', 'No active schedules found for this doctor at this hospital.', 404);
  }

  const DAY_MAP: Record<number, string> = {
    0: 'sunday', 1: 'monday', 2: 'tuesday', 3: 'wednesday',
    4: 'thursday', 5: 'friday', 6: 'saturday',
  };

  const scheduleByDay = new Map<string, typeof schedules>();
  for (const s of schedules) {
    const arr = scheduleByDay.get(s.day_of_week) ?? [];
    arr.push(s);
    scheduleByDay.set(s.day_of_week, arr);
  }

  function pad2(n: number) { return String(n).padStart(2, '0'); }
  function toHHMM(totalMins: number) { return `${pad2(Math.floor(totalMins / 60))}:${pad2(totalMins % 60)}`; }

  const rows: Array<{
    doctor_id: string; hospital_id: string; schedule_id: string; date: string;
    slot_start_time: string; slot_end_time: string; duration_minutes: number;
    status: OpdSlotStatus; published_at: Date;
  }> = [];

  const from = new Date(fromDate + 'T00:00:00');
  const to   = new Date(toDate   + 'T00:00:00');

  for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
    const dayName   = DAY_MAP[d.getDay()];
    const dateStr   = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const dayScheds = scheduleByDay.get(dayName) ?? [];

    for (const sch of dayScheds) {
      const [endH, endM] = sch.end_time.split(':').map(Number);
      const endMins      = endH * 60 + endM;
      const dur          = sch.slot_duration_minutes;
      const [stH, stM]   = sch.start_time.split(':').map(Number);
      let   cursor       = stH * 60 + stM;

      while (cursor + dur <= endMins) {
        rows.push({
          doctor_id:        doctorId,
          hospital_id:      hospitalId,
          schedule_id:      sch.id,
          date:             dateStr,
          slot_start_time:  toHHMM(cursor),
          slot_end_time:    toHHMM(cursor + dur),
          duration_minutes: dur,
          status:           OpdSlotStatus.PUBLISHED,
          published_at:     new Date(),
        });
        cursor += dur;
      }
    }
  }

  if (!rows.length) return ok({ generated: 0 });

  const created = await OpdSlotSession.bulkCreate(rows as any, { ignoreDuplicates: true });

  // Invalidate cached slot lists for every date that had rows inserted
  const affectedDates = [...new Set(rows.map((r) => r.date))];
  await Promise.all(affectedDates.map((d) => redis.del(RedisKeys.publishedSlots(doctorId, d))));

  logger.info('Slots generated', { doctorId, hospitalId, fromDate, toDate, generated: created.length });
  return ok({ generated: created.length });
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
