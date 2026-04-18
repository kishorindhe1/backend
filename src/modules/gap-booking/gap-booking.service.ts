import { Op }                            from 'sequelize';
import { sequelize }                      from '../../config/database';
import {
  DoctorAvailabilityWindow, WindowBookingMode,
  DoctorAvailabilityOverride, OverrideType,
  ProcedureType,
  OpdSlotSession, OpdSlotStatus, BookingEngine,
  Appointment, AppointmentStatus, PaymentStatus,
  AppointmentType, PaymentMode, VisitType,
  DoctorHospitalAffiliation,
  Hospital, AppointmentApprovalMode, PaymentCollectionMode,
  DayOfWeek,
}                                         from '../../models';
import { redis, RedisKeys, RedisTTL }     from '../../config/redis';
import { ServiceResponse, ok, fail }      from '../../types';
import { ErrorFactory }                   from '../../utils/errors';
import { addToQueue }                     from '../queue/queue.service';
import { logger }                         from '../../utils/logger';

// ── Day-of-week helper ────────────────────────────────────────────────────────
const JS_DAY_TO_ENUM: DayOfWeek[] = [
  DayOfWeek.SUNDAY, DayOfWeek.MONDAY, DayOfWeek.TUESDAY,
  DayOfWeek.WEDNESDAY, DayOfWeek.THURSDAY, DayOfWeek.FRIDAY, DayOfWeek.SATURDAY,
];

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

// ── Procedure type CRUD ───────────────────────────────────────────────────────

export async function listProcedureTypes(
  doctorId:   string,
  hospitalId: string,
): Promise<ServiceResponse<object[]>> {
  const types = await ProcedureType.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
    order: [['name', 'ASC']],
  });
  return ok(types.map((t) => t.toJSON()));
}

export async function createProcedureType(payload: {
  doctor_id:            string;
  hospital_id:          string;
  name:                 string;
  duration_minutes:     number;
  category?:            string;
  prep_time_minutes?:   number;
  cleanup_time_minutes?: number;
  color_code?:          string;
}): Promise<ServiceResponse<object>> {
  const pt = await ProcedureType.create({
    doctor_id:            payload.doctor_id,
    hospital_id:          payload.hospital_id,
    name:                 payload.name,
    duration_minutes:     payload.duration_minutes,
    category:             (payload.category as any) ?? undefined,
    prep_time_minutes:    payload.prep_time_minutes    ?? 0,
    cleanup_time_minutes: payload.cleanup_time_minutes ?? 0,
    color_code:           payload.color_code ?? null,
  });
  return ok(pt.toJSON());
}

export async function updateProcedureType(
  id:      string,
  changes: Partial<{ name: string; duration_minutes: number; prep_time_minutes: number; cleanup_time_minutes: number; color_code: string; is_active: boolean }>,
): Promise<ServiceResponse<object>> {
  const pt = await ProcedureType.findByPk(id);
  if (!pt) return fail('NOT_FOUND', 'Procedure type not found.', 404);
  await pt.update(changes);
  return ok(pt.toJSON());
}

// ── Gap-finding algorithm ─────────────────────────────────────────────────────

export interface AvailableGap {
  start_time:        string;   // HH:MM
  end_time:          string;   // HH:MM
  duration_minutes:  number;   // total including prep/cleanup
  bookable_duration: number;   // actual procedure duration (what patient experiences)
}

export async function findAvailableGaps(
  doctorId:          string,
  hospitalId:        string,
  date:              string,   // YYYY-MM-DD
  procedureTypeId:   string,
  stepMinutes:       number = 15,   // granularity of gap search
): Promise<ServiceResponse<{ gaps: AvailableGap[]; procedure_type: object }>> {

  const targetDate = new Date(`${date}T00:00:00`);
  if (isNaN(targetDate.getTime())) {
    return fail('INVALID_DATE', 'date must be YYYY-MM-DD.', 400);
  }

  const dayEnum = JS_DAY_TO_ENUM[targetDate.getDay()];

  // 1. Fetch procedure type
  const pt = await ProcedureType.findOne({
    where: { id: procedureTypeId, doctor_id: doctorId, hospital_id: hospitalId, is_active: true },
  });
  if (!pt) return fail('PROCEDURE_NOT_FOUND', 'Procedure type not found.', 404);

  const totalDuration = pt.duration_minutes + pt.prep_time_minutes + pt.cleanup_time_minutes;

  // 2. Fetch availability windows for this day
  const windows = await DoctorAvailabilityWindow.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      day_of_week: dayEnum,
      booking_mode: WindowBookingMode.GAP_BASED,
      is_active:   true,
      effective_from: { [Op.lte]: targetDate },
      [Op.or]: [
        { effective_until: null },
        { effective_until: { [Op.gte]: targetDate } },
      ],
    },
  });

  if (!windows.length) {
    return ok({ gaps: [], procedure_type: pt.toJSON() });
  }

  // 3. Apply overrides for this date
  const overrides = await DoctorAvailabilityOverride.findAll({
    where: { doctor_id: doctorId, hospital_id: hospitalId, date },
  });

  const isDayOff = overrides.some((o) => o.override_type === OverrideType.DAY_OFF);
  if (isDayOff) return ok({ gaps: [], procedure_type: pt.toJSON() });

  // Collect break windows from overrides
  const breakWindows: Array<{ start: number; end: number }> = overrides
    .filter((o) => o.override_type === OverrideType.BREAK && o.start_time && o.end_time)
    .map((o) => ({ start: toMinutes(o.start_time!), end: toMinutes(o.end_time!) }));

  // 4. Fetch existing booked/reserved slots for this date
  const booked = await OpdSlotSession.findAll({
    where: {
      doctor_id:   doctorId,
      hospital_id: hospitalId,
      date,
      status: { [Op.in]: [OpdSlotStatus.BOOKED, OpdSlotStatus.RESERVED_EMERGENCY] },
    },
    attributes: ['slot_start_time', 'slot_end_time'],
  });

  // Build busy intervals in minutes
  const busy: Array<{ start: number; end: number }> = booked.map((s) => ({
    start: toMinutes(s.slot_start_time),
    end:   toMinutes(s.slot_end_time),
  }));

  // 5. Find gaps within each availability window
  const gaps: AvailableGap[] = [];

  for (const win of windows) {
    // Apply late_start / early_end overrides
    let winStart = toMinutes(win.window_start);
    let winEnd   = toMinutes(win.window_end);

    for (const o of overrides) {
      if (o.override_type === OverrideType.LATE_START && o.start_time) {
        winStart = Math.max(winStart, toMinutes(o.start_time));
      }
      if (o.override_type === OverrideType.EARLY_END && o.end_time) {
        winEnd = Math.min(winEnd, toMinutes(o.end_time));
      }
    }

    // Slide through window with step
    for (let cursor = winStart; cursor + totalDuration <= winEnd; cursor += stepMinutes) {
      const slotEnd = cursor + totalDuration;

      // Check overlap with busy slots
      const overlaps = busy.some((b) => cursor < b.end && slotEnd > b.start);
      if (overlaps) continue;

      // Check overlap with breaks
      const inBreak = breakWindows.some((b) => cursor < b.end && slotEnd > b.start);
      if (inBreak) continue;

      // Check this gap isn't already in results (deduplicate)
      const startStr = toHHMM(cursor);
      if (gaps.some((g) => g.start_time === startStr)) continue;

      gaps.push({
        start_time:        startStr,
        end_time:          toHHMM(slotEnd),
        duration_minutes:  totalDuration,
        bookable_duration: pt.duration_minutes,
      });
    }
  }

  logger.info('Gap search complete', { doctorId, hospitalId, date, procedureTypeId, found: gaps.length });
  return ok({ gaps, procedure_type: pt.toJSON() });
}

// ── Book a gap ────────────────────────────────────────────────────────────────

export interface BookGapInput {
  patient_id:       string;
  doctor_id:        string;
  hospital_id:      string;
  date:             string;
  procedure_type_id: string;
  start_time:       string;   // HH:MM — chosen gap
  notes?:           string;
  payment_mode?:    PaymentMode;
}

export async function bookGap(input: BookGapInput): Promise<ServiceResponse<object>> {
  const { patient_id, doctor_id, hospital_id, date, procedure_type_id, start_time, notes } = input;

  // Validate procedure type
  const pt = await ProcedureType.findOne({
    where: { id: procedure_type_id, doctor_id, hospital_id, is_active: true },
  });
  if (!pt) throw ErrorFactory.notFound('PROCEDURE_NOT_FOUND', 'Procedure type not found.');

  const totalDuration = pt.duration_minutes + pt.prep_time_minutes + pt.cleanup_time_minutes;
  const endTime       = toHHMM(toMinutes(start_time) + totalDuration);

  // Distributed lock on this time slot
  const lockKey = `lock:gap:${doctor_id}:${date}:${start_time}`;
  const lockVal = `${patient_id}-${Date.now()}`;
  const acquired = await redis.set(lockKey, lockVal, 'EX', RedisTTL.SLOT_LOCK, 'NX');
  if (!acquired) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This time slot is being booked. Try another.');

  try {
    // Re-verify gap is still available (within transaction)
    const result = await sequelize.transaction(async (t) => {
      // Check no overlap
      const conflict = await OpdSlotSession.findOne({
        where: {
          doctor_id,
          hospital_id,
          date,
          status: { [Op.in]: [OpdSlotStatus.BOOKED, OpdSlotStatus.RESERVED_EMERGENCY] },
          // any existing slot that overlaps [start_time, endTime)
          slot_start_time: { [Op.lt]: endTime },
          slot_end_time:   { [Op.gt]: start_time },
        },
        lock: t.LOCK.UPDATE,
        transaction: t,
      });
      if (conflict) throw ErrorFactory.conflict('SLOT_UNAVAILABLE', 'This time slot is no longer available.');

      const hospital = await Hospital.findByPk(hospital_id, {
        attributes: ['appointment_approval', 'payment_collection_mode'],
        transaction: t,
      });
      if (!hospital) throw ErrorFactory.notFound('HOSPITAL_NOT_FOUND', 'Hospital not found.');

      const isAutoApproval    = hospital.appointment_approval === AppointmentApprovalMode.AUTO;
      const isPatientChoice   = hospital.payment_collection_mode === PaymentCollectionMode.PATIENT_CHOICE;
      const resolvedPayMode   = isPatientChoice && input.payment_mode ? input.payment_mode : PaymentMode.ONLINE_PREPAID;
      const isCashOrCard      = resolvedPayMode === PaymentMode.CASH || resolvedPayMode === PaymentMode.CARD;

      const affiliation = await DoctorHospitalAffiliation.findOne({
        where: { doctor_id, hospital_id, is_active: true },
        transaction: t,
      });
      if (!affiliation) throw ErrorFactory.unprocessable('DOCTOR_NOT_AFFILIATED', 'Doctor not affiliated with this hospital.');

      const fee    = Number(affiliation.consultation_fee);
      const pfee   = Math.round(fee * (0.02) * 100) / 100;
      const payout = fee - pfee;

      let initialStatus: AppointmentStatus;
      if (!isAutoApproval)      initialStatus = AppointmentStatus.AWAITING_HOSPITAL_APPROVAL;
      else if (isCashOrCard)    initialStatus = AppointmentStatus.CONFIRMED;
      else                      initialStatus = AppointmentStatus.PENDING;

      // Build scheduled_at from date + start_time
      const scheduledAt = new Date(`${date}T${start_time}:00`);

      // Create appointment
      const appointment = await Appointment.create({
        patient_id, doctor_id, hospital_id,
        slot_id:          null,   // gap-based appointments have no generated_slot row
        scheduled_at:     scheduledAt,
        status:           initialStatus,
        payment_status:   PaymentStatus.PENDING,
        appointment_type: AppointmentType.ONLINE_BOOKING,
        payment_mode:     resolvedPayMode,
        consultation_fee: fee,
        platform_fee:     pfee,
        doctor_payout:    payout,
        notes:            notes ?? null,
        visit_type:       VisitType.PROCEDURE,
        procedure_type_id,
        cancellation_reason: null, cancelled_by: null, cancelled_at: null,
        razorpay_order_id: null,
      }, { transaction: t });

      // Create OpdSlotSession (BOOKED immediately — no draft phase for gap-based)
      const session = await OpdSlotSession.create({
        doctor_id, hospital_id,
        schedule_id:      null,
        date,
        slot_start_time:  start_time,
        slot_end_time:    endTime,
        duration_minutes: totalDuration,
        booking_engine:   BookingEngine.GAP_BASED,
        status:           OpdSlotStatus.BOOKED,
        procedure_type_id,
        appointment_id:   appointment.id,
        custom_duration_minutes: pt.duration_minutes,
        custom_added:     false,
        walk_in_token_id: null,
        blocked_reason:   null,
        published_at:     new Date(),
      }, { transaction: t });

      return { appointment, session };
    });

    // Invalidate caches
    await redis.del(RedisKeys.availableSlots(doctor_id, date));
    await redis.del(RedisKeys.publishedSlots(doctor_id, date));

    // Add to consultation queue
    const scheduledAt = new Date(`${date}T${start_time}:00`);
    await addToQueue(result.appointment.id, doctor_id, hospital_id, patient_id, scheduledAt);

    logger.info('Gap booked', { appointmentId: result.appointment.id, doctorId: doctor_id, date, startTime: start_time, procedureTypeId: procedure_type_id });

    return ok({
      appointment_id:   result.appointment.id,
      opd_slot_id:      result.session.id,
      status:           result.appointment.status,
      payment_status:   result.appointment.payment_status,
      scheduled_at:     result.appointment.scheduled_at,
      slot_start_time:  start_time,
      slot_end_time:    endTime,
      duration_minutes: totalDuration,
      consultation_fee: Number(result.appointment.consultation_fee),
    });
  } finally {
    const cur = await redis.get(lockKey);
    if (cur === lockVal) await redis.del(lockKey);
  }
}
