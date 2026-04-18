import { Op }                              from 'sequelize';
import {
  Schedule, DayOfWeek, ScheduleBookingMode,
  DoctorHospitalAffiliation,
  HospitalClosure,
  DoctorAvailabilityOverride, OverrideType,
  OpdSlotSession, OpdSlotStatus, BookingEngine,
  OpdReviewLog,
  ConsultationQueue, QueueStatus,
  DoctorDelayEvent, DelayStatus,
  DoctorProfile,
  WalkInToken,
  SlotAutonomyLevel,
}                                           from '../../models';
import { redis, RedisKeys, RedisTTL }       from '../../config/redis';
import { ServiceResponse, ok, fail }        from '../../types';
import { logger }                           from '../../utils/logger';

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

function toTimeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── Draft slots for a hospital on a specific date ────────────────────────────
export async function draftSlotsForDate(
  hospitalId: string,
  date: string,  // YYYY-MM-DD
): Promise<ServiceResponse<{ doctors_drafted: number; total_slots: number; skipped_doctors: string[] }>> {

  const targetDate = new Date(`${date}T00:00:00`);
  if (isNaN(targetDate.getTime())) {
    return fail('INVALID_DATE', 'date must be a valid YYYY-MM-DD string.', 400);
  }

  // 1. Check hospital closure
  const closure = await HospitalClosure.findOne({
    where: { hospital_id: hospitalId, closure_date: date },
  });
  if (closure?.closure_type === 'full_day') {
    logger.info('Skipping slot draft — hospital closed', { hospitalId, date });
    return ok({ doctors_drafted: 0, total_slots: 0, skipped_doctors: ['hospital_closed'] });
  }

  // Partial closure: determine blocked window
  const partialBlockStart = closure?.start_time ?? null;
  const partialBlockEnd   = closure?.end_time   ?? null;

  // 2. Fetch all active affiliations for this hospital
  const affiliations = await DoctorHospitalAffiliation.findAll({
    where: { hospital_id: hospitalId, is_active: true },
  });

  const dayEnum = JS_DAY_TO_ENUM[targetDate.getDay()];
  let doctorsDrafted = 0;
  let totalSlots     = 0;
  const skippedDoctors: string[] = [];

  for (const aff of affiliations) {
    const doctorId = aff.doctor_id;

    // 3. Find active schedule for this day
    const schedule = await Schedule.findOne({
      where: {
        doctor_id:   doctorId,
        hospital_id: hospitalId,
        day_of_week: dayEnum,
        is_active:   true,
        effective_from: { [Op.lte]: targetDate },
        [Op.or]: [
          { effective_until: null },
          { effective_until: { [Op.gte]: targetDate } },
        ],
      },
    });

    if (!schedule) {
      skippedDoctors.push(doctorId);
      continue;
    }

    // Gap-based doctors handled in Phase 6
    if (schedule.booking_mode === ScheduleBookingMode.GAP_BASED) {
      skippedDoctors.push(doctorId);
      continue;
    }

    // 4. Fetch overrides for this doctor+date
    const overrides = await DoctorAvailabilityOverride.findAll({
      where: { doctor_id: doctorId, hospital_id: hospitalId, date },
    });

    // day_off override → skip entirely
    const isDayOff = overrides.some((o) => o.override_type === OverrideType.DAY_OFF);
    if (isDayOff) {
      skippedDoctors.push(doctorId);
      continue;
    }

    // 5. Build effective window from schedule + overrides
    let windowStart = schedule.start_time;
    let windowEnd   = schedule.end_time;

    for (const override of overrides) {
      if (override.override_type === OverrideType.LATE_START && override.start_time) {
        // Push start forward if override is later
        if (override.start_time > windowStart) windowStart = override.start_time;
      }
      if (override.override_type === OverrideType.EARLY_END && override.end_time) {
        // Pull end earlier if override is sooner
        if (override.end_time < windowEnd) windowEnd = override.end_time;
      }
    }

    // Collect break windows
    const breaks: Array<{ start: string; end: string }> = overrides
      .filter((o) => o.override_type === OverrideType.BREAK && o.start_time && o.end_time)
      .map((o) => ({ start: o.start_time!, end: o.end_time! }));

    // Apply partial hospital closure as a break
    if (partialBlockStart && partialBlockEnd) {
      breaks.push({ start: partialBlockStart, end: partialBlockEnd });
    }

    // Extra hours override (additional window — generate after main window)
    const extraWindows: Array<{ start: string; end: string }> = overrides
      .filter((o) => o.override_type === OverrideType.EXTRA_HOURS && o.start_time && o.end_time)
      .map((o) => ({ start: o.start_time!, end: o.end_time! }));

    // 6. Generate slots from the effective window
    const slotsGenerated = await generateDraftSlots({
      doctorId,
      hospitalId,
      scheduleId: schedule.id,
      date,
      targetDate,
      windowStart,
      windowEnd,
      slotDurationMinutes: schedule.slot_duration_minutes,
      bufferMinutes:       schedule.buffer_minutes,
      maxPatients:         schedule.max_patients,
      emergencyReserveSlots: schedule.emergency_reserve_slots,
      breaks,
    });

    // Extra hours windows
    for (const extra of extraWindows) {
      await generateDraftSlots({
        doctorId,
        hospitalId,
        scheduleId: schedule.id,
        date,
        targetDate,
        windowStart:         extra.start,
        windowEnd:           extra.end,
        slotDurationMinutes: schedule.slot_duration_minutes,
        bufferMinutes:       schedule.buffer_minutes,
        maxPatients:         schedule.max_patients,
        emergencyReserveSlots: 0,
        breaks: [],
      });
    }

    if (slotsGenerated > 0) {
      doctorsDrafted++;
      totalSlots += slotsGenerated;

      // FULL autonomy doctors auto-publish immediately — no admin review required
      if (aff.slot_autonomy_level === SlotAutonomyLevel.FULL) {
        await OpdSlotSession.update(
          { status: OpdSlotStatus.PUBLISHED },
          { where: { doctor_id: doctorId, hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT } },
        );
      }
    }
  }

  logger.info('Slots drafted', { hospitalId, date, doctorsDrafted, totalSlots });
  return ok({ doctors_drafted: doctorsDrafted, total_slots: totalSlots, skipped_doctors: skippedDoctors });
}

// ── Internal helper — generate DRAFT OpdSlotSession rows ─────────────────────
async function generateDraftSlots(params: {
  doctorId:             string;
  hospitalId:           string;
  scheduleId:           string;
  date:                 string;
  targetDate:           Date;
  windowStart:          string;
  windowEnd:            string;
  slotDurationMinutes:  number;
  bufferMinutes:        number;
  maxPatients:          number;
  emergencyReserveSlots: number;
  breaks:               Array<{ start: string; end: string }>;
}): Promise<number> {
  const {
    doctorId, hospitalId, scheduleId, date, targetDate,
    windowStart, windowEnd, slotDurationMinutes, bufferMinutes,
    maxPatients, emergencyReserveSlots, breaks,
  } = params;

  const startTime = parseTime(windowStart, targetDate);
  const endTime   = parseTime(windowEnd,   targetDate);
  const slotMs    = slotDurationMinutes * 60 * 1000;
  const bufferMs  = bufferMinutes       * 60 * 1000;
  const stepMs    = slotMs + bufferMs;

  let current = new Date(startTime);
  let count   = 0;
  let created = 0;
  const regularSlotLimit = maxPatients - emergencyReserveSlots;

  while (current < endTime && count < regularSlotLimit) {
    const slotEnd = new Date(current.getTime() + slotMs);

    // Skip if slot end exceeds window end
    if (slotEnd > endTime) break;

    const slotStartStr = toTimeStr(current);
    const slotEndStr   = toTimeStr(slotEnd);

    // Check if this slot falls in a break window
    const inBreak = breaks.some((b) => slotStartStr >= b.start && slotStartStr < b.end);
    if (!inBreak) {
      try {
        await OpdSlotSession.create({
          doctor_id:        doctorId,
          hospital_id:      hospitalId,
          schedule_id:      scheduleId,
          date,
          slot_start_time:  slotStartStr,
          slot_end_time:    slotEndStr,
          duration_minutes: slotDurationMinutes,
          booking_engine:   BookingEngine.FIXED_SLOTS,
          status:           OpdSlotStatus.DRAFT,
          custom_duration_minutes: null,
          custom_added:     false,
          appointment_id:   null,
          walk_in_token_id: null,
          procedure_type_id: null,
          blocked_reason:   null,
          published_at:     null,
        });
        created++;
        count++;
      } catch (err: unknown) {
        // Unique constraint — slot already exists, skip
        if ((err as { name?: string }).name !== 'SequelizeUniqueConstraintError') throw err;
      }
    }

    current = new Date(current.getTime() + stepMs);
  }

  // Emergency reserve slots at the end of the window
  if (emergencyReserveSlots > 0 && current < endTime) {
    for (let i = 0; i < emergencyReserveSlots && current < endTime; i++) {
      const slotEnd    = new Date(current.getTime() + slotMs);
      if (slotEnd > endTime) break;
      const slotStartStr = toTimeStr(current);
      const slotEndStr   = toTimeStr(slotEnd);
      try {
        await OpdSlotSession.create({
          doctor_id:        doctorId,
          hospital_id:      hospitalId,
          schedule_id:      scheduleId,
          date,
          slot_start_time:  slotStartStr,
          slot_end_time:    slotEndStr,
          duration_minutes: slotDurationMinutes,
          booking_engine:   BookingEngine.FIXED_SLOTS,
          status:           OpdSlotStatus.RESERVED_EMERGENCY,
          custom_duration_minutes: null,
          custom_added:     false,
          appointment_id:   null,
          walk_in_token_id: null,
          procedure_type_id: null,
          blocked_reason:   null,
          published_at:     null,
        });
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== 'SequelizeUniqueConstraintError') throw err;
      }
      current = new Date(current.getTime() + stepMs);
    }
  }

  return created;
}

// ── Publish slots for a hospital on a date ───────────────────────────────────
export async function publishSlots(
  hospitalId: string,
  date:       string,
  reviewedBy: string,  // user_id of receptionist
): Promise<ServiceResponse<{ published: number }>> {

  const drafts = await OpdSlotSession.findAll({
    where: { hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT },
  });

  if (!drafts.length) {
    return fail('NO_DRAFTS', 'No draft slots found for this hospital and date.', 404);
  }

  const now = new Date();
  await OpdSlotSession.update(
    { status: OpdSlotStatus.PUBLISHED, published_at: now },
    { where: { hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT } },
  );

  // Upsert review log
  await OpdReviewLog.upsert({
    hospital_id:    hospitalId,
    date,
    reviewed_by:    reviewedBy,
    reviewed_at:    now,
    auto_published: false,
    notes:          null,
  });

  // Invalidate Redis cache for all affected doctors
  const doctorIds = [...new Set(drafts.map((s) => s.doctor_id))];
  await Promise.all(doctorIds.map((id) => redis.del(RedisKeys.publishedSlots(id, date))));

  logger.info('Slots published', { hospitalId, date, published: drafts.length, reviewedBy });
  return ok({ published: drafts.length });
}

// ── Auto-publish unreviewed drafts (cron fallback) ───────────────────────────
export async function autoPublishUnreviewed(
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<{ published: number }>> {

  const drafts = await OpdSlotSession.findAll({
    where: { hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT },
    attributes: ['id', 'doctor_id'],
  });

  if (!drafts.length) return ok({ published: 0 });

  const now = new Date();
  await OpdSlotSession.update(
    { status: OpdSlotStatus.PUBLISHED, published_at: now },
    { where: { hospital_id: hospitalId, date, status: OpdSlotStatus.DRAFT } },
  );

  await OpdReviewLog.upsert({
    hospital_id:    hospitalId,
    date,
    reviewed_by:    null,
    reviewed_at:    now,
    auto_published: true,
    notes:          'Auto-published — no receptionist review before deadline',
  });

  const doctorIds = [...new Set(drafts.map((s) => s.doctor_id))];
  await Promise.all(doctorIds.map((id) => redis.del(RedisKeys.publishedSlots(id, date))));

  logger.warn('Slots auto-published without review', { hospitalId, date, published: drafts.length });
  return ok({ published: drafts.length });
}

// ── Get draft slots for review screen ────────────────────────────────────────
export async function getDraftSlots(
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<{
  reviewed: boolean;
  auto_published: boolean;
  doctors: Array<{
    doctor_id:    string;
    draft_count:  number;
    has_override: boolean;
    slots:        object[];
  }>;
}>> {

  const [slots, reviewLog] = await Promise.all([
    OpdSlotSession.findAll({
      where: { hospital_id: hospitalId, date, status: { [Op.in]: [OpdSlotStatus.DRAFT, OpdSlotStatus.RESERVED_EMERGENCY] } },
      order: [['slot_start_time', 'ASC']],
    }),
    OpdReviewLog.findOne({ where: { hospital_id: hospitalId, date } }),
  ]);

  // Group by doctor
  const byDoctor = new Map<string, typeof slots>();
  for (const slot of slots) {
    const existing = byDoctor.get(slot.doctor_id) ?? [];
    existing.push(slot);
    byDoctor.set(slot.doctor_id, existing);
  }

  // Check which doctors have overrides for this date
  const doctorIds = [...byDoctor.keys()];
  const overrides = doctorIds.length > 0
    ? await DoctorAvailabilityOverride.findAll({
        where: { doctor_id: { [Op.in]: doctorIds }, hospital_id: hospitalId, date },
        attributes: ['doctor_id'],
      })
    : [];
  const doctorsWithOverrides = new Set(overrides.map((o) => o.doctor_id));

  const doctors = [...byDoctor.entries()].map(([doctorId, doctorSlots]) => ({
    doctor_id:    doctorId,
    draft_count:  doctorSlots.filter((s) => s.status === OpdSlotStatus.DRAFT).length,
    has_override: doctorsWithOverrides.has(doctorId),
    slots:        doctorSlots.map((s) => s.toJSON()),
  }));

  return ok({
    reviewed:       !!reviewLog,
    auto_published: reviewLog?.auto_published ?? false,
    doctors,
  });
}

// ── Get published available slots (replaces old getAvailableSlots) ────────────
export async function getPublishedSlots(
  doctorId:   string,
  hospitalId: string,
  date:       string,
): Promise<ServiceResponse<object[]>> {

  const cacheKey = RedisKeys.publishedSlots(doctorId, date);
  const cached   = await redis.get(cacheKey);
  if (cached) return ok(JSON.parse(cached));

  const slots = await OpdSlotSession.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      status:      OpdSlotStatus.PUBLISHED,
      date,
    },
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

// ── Today's live OPD dashboard ────────────────────────────────────────────────
// Returns all doctors with published slots today + live queue state per doctor.
export interface TodayDoctorSummary {
  doctor_id:       string;
  doctor_name:     string;
  specialization:  string;
  total_slots:     number;
  booked_slots:    number;
  empty_slots:     number;
  walk_in_slots:   number;
  completed_slots: number;
  current_token:   number | null;
  waiting_count:   number;
  delay_minutes:   number;
  doctor_status:   'available' | 'in_consultation' | 'delayed' | 'absent';
  slots:           Array<{
    id: string; slot_start_time: string; slot_end_time: string;
    status: string; walk_in_token_id: string | null; appointment_id: string | null;
  }>;
}

export async function getTodayOPD(
  hospitalId: string,
): Promise<ServiceResponse<{ date: string; doctors: TodayDoctorSummary[] }>> {
  const date = new Date().toISOString().split('T')[0];

  // All published/booked/completed slots for this hospital today
  const allSlots = await OpdSlotSession.findAll({
    where: {
      hospital_id: hospitalId,
      date,
      status: { [Op.in]: [OpdSlotStatus.PUBLISHED, OpdSlotStatus.BOOKED, OpdSlotStatus.COMPLETED, OpdSlotStatus.CANCELLED] },
    },
    order: [['slot_start_time', 'ASC']],
  });

  if (!allSlots.length) {
    return ok({ date, doctors: [] });
  }

  // Group slots by doctor
  const byDoctor = new Map<string, typeof allSlots>();
  for (const slot of allSlots) {
    const existing = byDoctor.get(slot.doctor_id) ?? [];
    existing.push(slot);
    byDoctor.set(slot.doctor_id, existing);
  }

  const doctorIds = [...byDoctor.keys()];

  // Fetch doctor profiles, queue state, delay events in parallel
  const [doctors, queueEntries, delayEvents, walkInTokens] = await Promise.all([
    DoctorProfile.findAll({ where: { id: { [Op.in]: doctorIds } }, attributes: ['id', 'full_name', 'specialization'] }),
    ConsultationQueue.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, hospital_id: hospitalId, queue_date: date },
      attributes: ['doctor_id', 'queue_position', 'status'],
    }),
    DoctorDelayEvent.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, hospital_id: hospitalId, event_date: date, status: DelayStatus.ACTIVE },
      attributes: ['doctor_id', 'delay_minutes', 'delay_type'],
    }),
    WalkInToken.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, hospital_id: hospitalId, date },
      attributes: ['doctor_id', 'token_number', 'status'],
    }),
  ]);

  const doctorMap  = new Map(doctors.map((d) => [d.id, d]));
  const delayMap   = new Map(delayEvents.map((e) => [e.doctor_id, e]));

  // Group queue entries by doctor
  const queueMap = new Map<string, typeof queueEntries>();
  for (const entry of queueEntries) {
    const list = queueMap.get(entry.doctor_id) ?? [];
    list.push(entry);
    queueMap.set(entry.doctor_id, list);
  }

  const summaries: TodayDoctorSummary[] = [];

  for (const [doctorId, slots] of byDoctor.entries()) {
    const doc      = doctorMap.get(doctorId);
    const delay    = delayMap.get(doctorId);
    const queue    = queueMap.get(doctorId) ?? [];

    const inConsult  = queue.find((q) => q.status === QueueStatus.IN_CONSULTATION);
    const waiting    = queue.filter((q) => q.status === QueueStatus.WAITING);

    let doctorStatus: TodayDoctorSummary['doctor_status'] = 'available';
    if (delay?.delay_type === 'absent') doctorStatus = 'absent';
    else if (delay) doctorStatus = 'delayed';
    else if (inConsult) doctorStatus = 'in_consultation';

    const slotList = slots.map((s) => ({
      id:               s.id,
      slot_start_time:  s.slot_start_time,
      slot_end_time:    s.slot_end_time,
      status:           s.status,
      walk_in_token_id: s.walk_in_token_id,
      appointment_id:   s.appointment_id,
    }));

    summaries.push({
      doctor_id:       doctorId,
      doctor_name:     (doc as any)?.full_name ?? doctorId.slice(0, 8),
      specialization:  (doc as any)?.specialization ?? '',
      total_slots:     slots.length,
      booked_slots:    slots.filter((s) => s.status === OpdSlotStatus.BOOKED && !s.walk_in_token_id).length,
      empty_slots:     slots.filter((s) => s.status === OpdSlotStatus.PUBLISHED).length,
      walk_in_slots:   slots.filter((s) => s.walk_in_token_id !== null).length,
      completed_slots: slots.filter((s) => s.status === OpdSlotStatus.COMPLETED).length,
      current_token:   inConsult?.queue_position ?? null,
      waiting_count:   waiting.length,
      delay_minutes:   delay?.delay_minutes ?? 0,
      doctor_status:   doctorStatus,
      slots:           slotList,
    });
  }

  // Sort: in_consultation first, then delayed, then available, then absent
  const ORDER: Record<string, number> = { in_consultation: 0, delayed: 1, available: 2, absent: 3 };
  summaries.sort((a, b) => (ORDER[a.doctor_status] ?? 2) - (ORDER[b.doctor_status] ?? 2));

  return ok({ date, doctors: summaries });
}
