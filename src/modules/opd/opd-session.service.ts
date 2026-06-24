import { Op } from 'sequelize';
import {
  OpdSession, OpdSessionStatus, OpdBookingMode,
  OpdSessionBreak,
  OpdToken, OpdTokenStatus,
  DoctorProfile, Hospital,
  Schedule, OpdBookingModeConfig,
} from '../../models';
import type { SessionsConfig, SessionDef } from '../../models';
import { ErrorFactory }                    from '../../utils/errors';
import { ServiceResponse, ok }             from '../../types';
import { logger }                          from '../../utils/logger';
import { istTime }                         from '../../utils/dateTime';
import { emit, OpdRooms, OpdEvents }       from '../../config/socket';
import { shiftWaitingTokenETAs, dateToDayOfWeek, addMinutesToTime } from './opd-helpers';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BreakInput {
  start_time: string;
  end_time:   string;
  reason?:    string;
}

export interface CreateSessionInput {
  doctor_id:             string;
  hospital_id:           string;
  session_date:          string;
  session_type:          string;
  start_time:            string;
  expected_end_time:     string;
  total_tokens:          number;
  booking_mode?:         OpdBookingMode;
  avg_time_per_patient?: number;
  breaks?:               BreakInput[];
}

// ── Create OPD session ────────────────────────────────────────────────────────

export async function createSession(input: CreateSessionInput): Promise<ServiceResponse<object>> {
  const existing = await OpdSession.findOne({
    where: { doctor_id: input.doctor_id, hospital_id: input.hospital_id, session_date: input.session_date, session_type: input.session_type },
  });
  if (existing) throw ErrorFactory.conflict('SESSION_EXISTS', 'A session for this doctor on this date already exists.');

  const breaks = input.breaks ?? [];
  for (const b of breaks) {
    if (b.start_time >= b.end_time) {
      throw ErrorFactory.unprocessable('INVALID_BREAK', `Break ${b.start_time}–${b.end_time}: start must be before end.`);
    }
    if (b.start_time < input.start_time || b.end_time > input.expected_end_time) {
      throw ErrorFactory.unprocessable('BREAK_OUTSIDE_SESSION', `Break ${b.start_time}–${b.end_time} falls outside session window.`);
    }
  }
  for (let i = 0; i < breaks.length; i++) {
    for (let j = i + 1; j < breaks.length; j++) {
      if (breaks[i].start_time < breaks[j].end_time && breaks[i].end_time > breaks[j].start_time) {
        throw ErrorFactory.unprocessable('BREAK_OVERLAP', `Breaks at ${breaks[i].start_time} and ${breaks[j].start_time} overlap.`);
      }
    }
  }

  const session = await OpdSession.create({
    doctor_id:            input.doctor_id,
    hospital_id:          input.hospital_id,
    session_date:         input.session_date,
    session_type:         input.session_type,
    start_time:           input.start_time,
    expected_end_time:    input.expected_end_time,
    total_tokens:         input.total_tokens,
    online_token_limit:   0,
    walkin_token_limit:   0,
    booking_mode:         input.booking_mode ?? OpdBookingMode.TOKEN_BASED,
    actual_start_time:    null,
    actual_end_time:      null,
    tokens_issued:        0,
    current_token:        0,
    avg_time_per_patient: input.avg_time_per_patient ?? 10,
    status:               OpdSessionStatus.SCHEDULED,
  });

  let createdBreaks: object[] = [];
  if (breaks.length > 0) {
    const records = await OpdSessionBreak.bulkCreate(
      breaks.map((b) => ({ session_id: session.id, start_time: b.start_time, end_time: b.end_time, reason: b.reason ?? null })),
    );
    createdBreaks = records.map((r) => r.toJSON());
  }

  logger.info('OPD session created', { sessionId: session.id, breaks: breaks.length });
  return ok({ ...session.toJSON(), breaks: createdBreaks });
}

// ── Activate session ──────────────────────────────────────────────────────────

export async function activateSession(sessionId: string, _receptionistId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.SCHEDULED) throw ErrorFactory.unprocessable('INVALID_STATUS', `Cannot activate a ${session.status} session.`);

  const timeStr = istTime();
  await session.update({ status: OpdSessionStatus.ACTIVE, actual_start_time: timeStr });

  emit(OpdRooms.hospital(session.hospital_id), OpdEvents.SESSION_STARTED, { session_id: sessionId, actual_start_time: timeStr });

  logger.info('OPD session activated', { sessionId });
  return ok({ session_id: sessionId, status: OpdSessionStatus.ACTIVE, actual_start_time: timeStr });
}

// ── Pause session (doctor break) ──────────────────────────────────────────────

export async function pauseSession(
  sessionId:              string,
  estimatedBreakMinutes?: number,
): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.ACTIVE) throw ErrorFactory.unprocessable('INVALID_STATUS', 'Only an active session can be paused.');

  const doctor = await DoctorProfile.findByPk(session.doctor_id, {
    attributes: ['break_type', 'break_window_start', 'break_window_end'],
  });
  if (doctor?.break_window_start && doctor.break_window_end) {
    const now  = new Date();
    const hhmm = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if (hhmm < doctor.break_window_start || hhmm > doctor.break_window_end) {
      throw ErrorFactory.unprocessable('OUTSIDE_BREAK_WINDOW',
        `Break can only be taken between ${doctor.break_window_start} and ${doctor.break_window_end}.`);
    }
  }

  await session.update({ status: OpdSessionStatus.PAUSED });

  const breakShift = estimatedBreakMinutes ?? 0;
  if (breakShift > 0) {
    await shiftWaitingTokenETAs(session.id, breakShift);
  }

  logger.info('OPD session paused (break)', { sessionId, estimatedBreakMinutes });
  return ok({
    session_id:              sessionId,
    status:                  OpdSessionStatus.PAUSED,
    estimated_break_minutes: breakShift,
    message:                 breakShift > 0
      ? `Break started. Waiting patients notified of ~${breakShift} min delay.`
      : 'Break started.',
  });
}

// ── Resume session ────────────────────────────────────────────────────────────

export async function resumeSession(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.PAUSED) throw ErrorFactory.unprocessable('INVALID_STATUS', 'Only a paused session can be resumed.');

  await session.update({ status: OpdSessionStatus.ACTIVE });
  logger.info('OPD session resumed', { sessionId });
  return ok({ session_id: sessionId, status: OpdSessionStatus.ACTIVE });
}

// ── Cancel session ────────────────────────────────────────────────────────────

export async function cancelSession(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status === OpdSessionStatus.COMPLETED || session.status === OpdSessionStatus.CANCELLED) {
    throw ErrorFactory.unprocessable('INVALID_STATUS', `Cannot cancel a ${session.status} session.`);
  }

  await session.update({ status: OpdSessionStatus.CANCELLED });
  logger.info('OPD session cancelled', { sessionId });
  return ok({ session_id: sessionId, status: OpdSessionStatus.CANCELLED });
}

// ── End session ───────────────────────────────────────────────────────────────
// Explicitly finish an active/paused session: completes any in-progress token,
// marks outstanding tokens no-show, and stamps the actual end time.

export async function endSession(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.ACTIVE && session.status !== OpdSessionStatus.PAUSED) {
    throw ErrorFactory.unprocessable('INVALID_STATUS', `Only an active or paused session can be ended (current: ${session.status}).`);
  }

  const now = new Date();

  // Close out the patient currently being seen
  const [completedInProgress] = await OpdToken.update(
    { status: OpdTokenStatus.COMPLETED, consultation_end: now },
    { where: { session_id: sessionId, status: OpdTokenStatus.IN_PROGRESS } },
  );

  // Everyone still in the queue is a no-show for this session
  const [noShowCount] = await OpdToken.update(
    { status: OpdTokenStatus.NO_SHOW },
    { where: { session_id: sessionId, status: { [Op.in]: [
      OpdTokenStatus.ISSUED, OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING, OpdTokenStatus.CALLED,
    ] } } },
  );

  await session.update({ status: OpdSessionStatus.COMPLETED, actual_end_time: istTime() });

  emit(OpdRooms.session(sessionId), OpdEvents.SESSION_ENDED, {
    session_id: sessionId, status: OpdSessionStatus.COMPLETED,
  });

  logger.info('OPD session ended', { sessionId, completedInProgress, noShowCount });
  return ok({
    session_id:        sessionId,
    status:            OpdSessionStatus.COMPLETED,
    completed_tokens:  completedInProgress,
    no_show_tokens:    noShowCount,
  });
}

// ── List sessions ─────────────────────────────────────────────────────────────

export async function listSessions(
  hospitalId: string,
  doctorId?:  string,
  date?:      string,
): Promise<ServiceResponse<object[]>> {
  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (doctorId) where.doctor_id    = doctorId;
  if (date)     where.session_date = date;

  const sessions = await OpdSession.findAll({
    where,
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
    order: [['session_date', 'DESC'], ['start_time', 'ASC']],
  });

  return ok(sessions.map((s) => s.toJSON()));
}

// ── OPD History — past sessions with summary stats ────────────────────────────

export async function getSessionHistory(
  hospitalId: string,
  doctorId?:  string,
  dateFrom?:  string,
  dateTo?:    string,
  status?:    OpdSessionStatus,
  page    = 1,
  perPage = 20,
): Promise<ServiceResponse<{ rows: object[]; count: number }>> {
  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (doctorId) where.doctor_id = doctorId;
  if (status)   where.status    = status;
  if (dateFrom && dateTo) {
    where.session_date = { [Op.between]: [dateFrom, dateTo] };
  } else if (dateFrom) {
    where.session_date = { [Op.gte]: dateFrom };
  } else if (dateTo) {
    where.session_date = { [Op.lte]: dateTo };
  }

  const { rows, count } = await OpdSession.findAndCountAll({
    where,
    include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name', 'specialization'] }],
    order:  [['session_date', 'DESC'], ['start_time', 'ASC']],
    limit:  perPage,
    offset: (page - 1) * perPage,
  });

  const { OpdToken, OpdTokenStatus: TS } = await import('../../models');
  const enriched = await Promise.all(rows.map(async (s) => {
    const [completed, skipped, no_show] = await Promise.all([
      OpdToken.count({ where: { session_id: s.id, status: TS.COMPLETED } }),
      OpdToken.count({ where: { session_id: s.id, status: TS.SKIPPED   } }),
      OpdToken.count({ where: { session_id: s.id, status: TS.NO_SHOW   } }),
    ]);
    const doc = s.get('doctor') as DoctorProfile | undefined;
    return {
      ...s.toJSON(),
      doctor_name:              doc?.full_name     ?? null,
      specialization:           doc?.specialization ?? null,
      completed_count:          completed,
      skipped_count:            skipped,
      no_show_count:            no_show,
      avg_consultation_minutes: Number(s.avg_time_per_patient),
    };
  }));

  return ok({ rows: enriched, count });
}

// ── Generate queue sessions from schedule config ──────────────────────────────

export async function generateSessionsFromSchedule(
  doctor_id:   string,
  hospital_id: string,
  date:        string,
): Promise<ServiceResponse<object[]>> {
  const dayOfWeek = dateToDayOfWeek(date);
  const schedule  = await Schedule.findOne({
    where: {
      doctor_id,
      hospital_id,
      day_of_week:      dayOfWeek,
      opd_booking_mode: OpdBookingModeConfig.TOKEN_BASED,
      is_active:        true,
    },
  });
  if (!schedule) {
    throw ErrorFactory.notFound('SCHEDULE_NOT_FOUND',
      'No active token-based schedule found for this doctor on this day.');
  }

  const config  = schedule.sessions_config as SessionsConfig | null;
  const avgMins = config?.avg_consultation_minutes ?? 10;
  let sessions: SessionDef[];

  if (config?.sessions && config.sessions.length > 0) {
    sessions = config.sessions;
  } else {
    sessions = [{
      name:         'Session 1',
      start_time:   schedule.start_time,
      max_patients: schedule.max_patients,
    }];
  }

  const created: object[] = [];
  for (const sess of sessions) {
    const existing = await OpdSession.findOne({
      where: { doctor_id, hospital_id, session_date: date, session_type: sess.name },
    });
    if (existing) { created.push(existing.toJSON()); continue; }

    const session = await OpdSession.create({
      doctor_id,
      hospital_id,
      schedule_id:          schedule.id,
      session_date:         date,
      session_type:         sess.name,
      booking_mode:         OpdBookingMode.TOKEN_BASED,
      start_time:           sess.start_time,
      expected_end_time:    addMinutesToTime(sess.start_time, sess.max_patients * avgMins),
      total_tokens:         sess.max_patients,
      online_token_limit:   0,
      walkin_token_limit:   0,
      tokens_issued:        0,
      current_token:        0,
      avg_time_per_patient: avgMins,
      status:               OpdSessionStatus.SCHEDULED,
    });
    created.push(session.toJSON());
  }

  logger.info('Queue sessions generated', { doctor_id, hospital_id, date, count: created.length });
  return ok(created);
}

// ── List available queue sessions for patient booking ─────────────────────────

export async function listAvailableSessions(
  doctor_id:   string,
  hospital_id: string,
  date:        string,
): Promise<ServiceResponse<object[]>> {
  const nowIST         = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const todayIST       = nowIST.toISOString().split('T')[0];
  const currentTimeIST = `${String(nowIST.getUTCHours()).padStart(2,'0')}:${String(nowIST.getUTCMinutes()).padStart(2,'0')}`;

  if (date < todayIST) return ok([]);

  const where: Record<string, unknown> = {
    doctor_id,
    hospital_id,
    session_date: date,
    booking_mode: OpdBookingMode.TOKEN_BASED,
    status: { [Op.in]: [OpdSessionStatus.SCHEDULED, OpdSessionStatus.ACTIVE, OpdSessionStatus.PAUSED] },
  };

  if (date === todayIST) {
    where.start_time        = { [Op.gt]: currentTimeIST };
    where.expected_end_time = { [Op.gt]: currentTimeIST };
  }

  const sessions = await OpdSession.findAll({ where, order: [['start_time', 'ASC']] });

  const result = sessions.map((s) => {
    const issued          = s.tokens_issued ?? 0;
    const current         = s.current_token ?? 0;
    const avgMins         = Number(s.avg_time_per_patient);
    const pendingAhead    = Math.max(0, issued - current);
    const estimatedWait   = pendingAhead * avgMins;
    const tokensRemaining = Math.max(0, s.total_tokens - issued);

    return {
      session_id:             s.id,
      session_type:           s.session_type,
      start_time:             s.start_time,
      expected_end_time:      s.expected_end_time,
      total_tokens:           s.total_tokens,
      tokens_issued:          issued,
      tokens_remaining:       tokensRemaining,
      current_token:          current,
      avg_time_per_patient:   avgMins,
      estimated_wait_minutes: estimatedWait,
      status:                 s.status,
      is_available:           tokensRemaining > 0 && s.status !== OpdSessionStatus.PAUSED,
    };
  });

  return ok(result);
}
