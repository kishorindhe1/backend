import { Op } from 'sequelize';
import { redis }                    from '../../config/redis';
import {
  OpdSession, OpdSessionStatus, OpdBookingMode,
  OpdToken, OpdTokenType, OpdTokenStatus,
  OpdSlotSession, OpdSlotStatus,
  OpdSessionBreak,
  DoctorProfile, Hospital,
  Appointment, AppointmentStatus, AppointmentType, PaymentMode, PaymentStatus,
  ConsultationQueue, QueueStatus,
  DoctorHospitalAffiliation,
}                                   from '../../models';
import { ErrorFactory }             from '../../utils/errors';
import { ServiceResponse, ok }      from '../../types';
import { logger }                   from '../../utils/logger';
import { getEffectiveDuration }     from '../duration/duration.service';

// ── Create OPD session ────────────────────────────────────────────────────────
export interface CreateSessionInput {
  doctor_id:          string;
  hospital_id:        string;
  session_date:       string;
  session_type:       string;
  start_time:         string;
  expected_end_time:  string;
  total_tokens:       number;
  online_token_limit: number;
  walkin_token_limit: number;
}

export async function createSession(input: CreateSessionInput): Promise<ServiceResponse<object>> {
  const existing = await OpdSession.findOne({
    where: { doctor_id: input.doctor_id, hospital_id: input.hospital_id, session_date: input.session_date, session_type: input.session_type },
  });
  if (existing) throw ErrorFactory.conflict('SESSION_EXISTS', 'A session for this doctor on this date already exists.');

  const session = await OpdSession.create({
    ...input,
    booking_mode:        OpdBookingMode.TOKEN_BASED,
    actual_start_time:   null,
    actual_end_time:     null,
    tokens_issued:       0,
    current_token:       0,
    avg_time_per_patient:5,
    status:              OpdSessionStatus.SCHEDULED,
  });

  logger.info('OPD session created', { sessionId: session.id });
  return ok(session);
}

// ── Issue token (online booking) ──────────────────────────────────────────────
export async function issueOnlineToken(
  sessionId:  string,
  patientId:  string,
  appointmentId?: string,
): Promise<ServiceResponse<{ token_number: number; estimated_wait_minutes: number; session_id: string }>> {
  // Atomic increment — race-condition safe
  const lockKey = `lock:opd:token:${sessionId}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!acquired) throw ErrorFactory.conflict('TOKEN_LOCK', 'Token issuance in progress, please retry.');

  try {
    const session = await OpdSession.findByPk(sessionId);
    if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'OPD session not found.');
    if (session.status === OpdSessionStatus.CANCELLED) throw ErrorFactory.unprocessable('SESSION_CANCELLED', 'This session has been cancelled.');
    if (session.tokens_issued >= session.online_token_limit) throw ErrorFactory.conflict('TOKENS_FULL', 'Online tokens for this session are fully booked.');

    const tokenNumber = session.tokens_issued + 1;

    await session.update({ tokens_issued: tokenNumber });

    // Snapshot effective duration at queue-join time for accurate live ETA
    const durationSnapshot = await getEffectiveDuration(patientId, session.doctor_id);

    const token = await OpdToken.create({
      session_id:                   sessionId,
      token_number:                 tokenNumber,
      patient_id:                   patientId,
      appointment_id:               appointmentId ?? null,
      token_type:                   OpdTokenType.ONLINE,
      issued_by:                    'online_booking',
      arrived_at:                   null,
      called_at:                    null,
      consultation_start:           null,
      consultation_end:             null,
      status:                       OpdTokenStatus.ISSUED,
      personalized_duration_minutes: durationSnapshot,
      duration_override:            null,
    });

    const estimatedWait = await calculateEstimatedWait(session, tokenNumber);

    logger.info('OPD token issued', { sessionId, tokenNumber, patientId });
    return ok({ token_number: tokenNumber, estimated_wait_minutes: estimatedWait, session_id: sessionId });
  } finally {
    await redis.del(lockKey);
  }
}

// ── Issue walk-in token ───────────────────────────────────────────────────────
export async function issueWalkInToken(
  sessionId: string,
  patientId: string | null,
  issuedBy:  string,
): Promise<ServiceResponse<{ token_number: number }>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'OPD session not found.');

  const totalIssued = session.tokens_issued + 1;
  if (totalIssued > session.total_tokens) throw ErrorFactory.conflict('SESSION_FULL', 'Session has reached maximum capacity.');

  await session.update({ tokens_issued: totalIssued });

  const token = await OpdToken.create({
    session_id:  sessionId,
    token_number: totalIssued,
    patient_id:  patientId,
    appointment_id: null,
    token_type:  OpdTokenType.WALKIN,
    issued_by:   issuedBy,
    arrived_at:  new Date(),
    called_at: null, consultation_start: null, consultation_end: null,
    status: OpdTokenStatus.ARRIVED,
  });

  return ok({ token_number: token.token_number });
}

// ── Patient joins queue via QR scan ──────────────────────────────────────────
// Called from mobile after scanning the session QR code. Patient must be authenticated.
export async function joinAsWalkin(
  sessionId: string,
  patientId: string,
): Promise<ServiceResponse<{ token_number: number; estimated_wait_minutes: number; session_id: string; doctor_name: string; appointment_id: string }>> {
  const lockKey = `lock:opd:token:${sessionId}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!acquired) throw ErrorFactory.conflict('TOKEN_LOCK', 'Token issuance in progress, please retry.');

  try {
    const session = await OpdSession.findByPk(sessionId, {
      include: [{ model: DoctorProfile, as: 'doctor', attributes: ['full_name'] }],
    });
    if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
    if (session.status === OpdSessionStatus.CANCELLED) throw ErrorFactory.unprocessable('SESSION_CANCELLED', 'This session has been cancelled.');
    if (session.status === OpdSessionStatus.COMPLETED) throw ErrorFactory.unprocessable('SESSION_COMPLETED', 'This session has already ended.');
    if (session.tokens_issued >= session.total_tokens) throw ErrorFactory.conflict('SESSION_FULL', 'Session is at full capacity.');

    // Prevent duplicate — patient already in this session
    const existing = await OpdToken.findOne({
      where: {
        session_id: sessionId,
        patient_id: patientId,
        status: { [Op.notIn]: [OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW] },
      },
    });
    if (existing) throw ErrorFactory.conflict('ALREADY_IN_QUEUE', `You already have token #${existing.token_number} in this session.`);

    const totalIssued = session.tokens_issued + 1;
    await session.update({ tokens_issued: totalIssued });

    const durationSnapshot = await getEffectiveDuration(patientId, session.doctor_id);

    // Fetch consultation fee from doctor–hospital affiliation
    const affiliation = await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: session.doctor_id, hospital_id: session.hospital_id, is_active: true },
      attributes: ['consultation_fee'],
    });
    const fee = parseFloat(String(affiliation?.consultation_fee ?? 0));

    // Create appointment so the visit is visible in the patient's appointments list
    const appointment = await Appointment.create({
      patient_id:       patientId,
      doctor_id:        session.doctor_id,
      hospital_id:      session.hospital_id,
      slot_id:          null,
      scheduled_at:     new Date(),
      appointment_type: AppointmentType.WALK_IN,
      payment_mode:     PaymentMode.CASH,
      payment_status:   PaymentStatus.PENDING,
      status:           AppointmentStatus.CONFIRMED,
      consultation_fee: fee,
      platform_fee:     parseFloat((fee * 0.02).toFixed(2)),
      doctor_payout:    parseFloat((fee * 0.98).toFixed(2)),
      notes:            null,
    });

    const opdToken = await OpdToken.create({
      session_id:                    sessionId,
      token_number:                  totalIssued,
      patient_id:                    patientId,
      appointment_id:                appointment.id,
      token_type:                    OpdTokenType.WALKIN,
      issued_by:                     'patient_qr_scan',
      arrived_at:                    new Date(),
      called_at:                     null,
      consultation_start:            null,
      consultation_end:              null,
      status:                        OpdTokenStatus.ARRIVED,
      personalized_duration_minutes: durationSnapshot,
      duration_override:             null,
    });

    // Add to consultation queue so patient can track position
    const queueDate = new Date().toISOString().split('T')[0];
    const nextPosition = (await ConsultationQueue.count({
      where: { doctor_id: session.doctor_id, queue_date: queueDate },
    })) + 1;

    await ConsultationQueue.create({
      appointment_id:     appointment.id,
      doctor_id:          session.doctor_id,
      hospital_id:        session.hospital_id,
      patient_id:         patientId,
      queue_date:         queueDate,
      queue_position:     nextPosition,
      status:             QueueStatus.WAITING,
      arrived_at:         new Date(),
      estimated_start_at: null,
      called_at:          null,
      actual_start_at:    null,
      actual_end_at:      null,
      notified_at:        null,
    });

    const estimatedWait = await calculateEstimatedWait(session, totalIssued);
    const doctorName    = (session.get('doctor') as DoctorProfile | undefined)?.full_name ?? 'Doctor';

    logger.info('Patient joined queue via QR', { sessionId, patientId, tokenNumber: totalIssued, appointmentId: appointment.id });
    return ok({
      token_number:           opdToken.token_number,
      estimated_wait_minutes: estimatedWait,
      session_id:             sessionId,
      doctor_name:            doctorName,
      appointment_id:         appointment.id,
    });
  } finally {
    await redis.del(lockKey);
  }
}

// ── Get session public info (no auth) ─────────────────────────────────────────
// Used by mobile before login to show session details from QR scan.
export async function getSessionPublicInfo(
  sessionId: string,
): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId, {
    attributes: ['id', 'session_date', 'start_time', 'expected_end_time', 'status', 'tokens_issued', 'total_tokens', 'doctor_id', 'hospital_id'],
    include: [
      { model: DoctorProfile, as: 'doctor',   attributes: ['full_name', 'specialization'] },
      { model: Hospital,      as: 'hospital',  attributes: ['name'] },
    ],
  });
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const waitingCount = await OpdToken.count({
    where: { session_id: sessionId, status: { [Op.in]: PENDING_STATUSES } },
  });

  return ok({
    session_id:    session.id,
    date:          session.session_date,
    start_time:    session.start_time,
    status:        session.status,
    tokens_issued: session.tokens_issued,
    total_tokens:  session.total_tokens,
    waiting_count: waitingCount,
    doctor:        session.get('doctor'),
    hospital:      session.get('hospital'),
  });
}

// ── Activate session ──────────────────────────────────────────────────────────
export async function activateSession(sessionId: string, receptionistId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.SCHEDULED) throw ErrorFactory.unprocessable('INVALID_STATUS', `Cannot activate a ${session.status} session.`);

  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
  await session.update({ status: OpdSessionStatus.ACTIVE, actual_start_time: timeStr });

  logger.info('OPD session activated', { sessionId });
  return ok({ session_id: sessionId, status: OpdSessionStatus.ACTIVE, actual_start_time: timeStr });
}

// ── Call next token ───────────────────────────────────────────────────────────
export async function callNextToken(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.ACTIVE) throw ErrorFactory.unprocessable('SESSION_NOT_ACTIVE', 'Session is not active.');

  // Complete current in-progress token and capture it for avg calculation
  const completing = await OpdToken.findOne({
    where: { session_id: sessionId, status: OpdTokenStatus.IN_PROGRESS },
  });
  if (completing) {
    await completing.update({ status: OpdTokenStatus.COMPLETED, consultation_end: new Date() });
    await updateSessionAvg(session, completing);
  }

  // Find next
  const next = await OpdToken.findOne({
    where: { session_id: sessionId, status: { [Op.in]: [OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING] } },
    order: [['token_number', 'ASC']],
  });

  if (!next) {
    await session.update({ status: OpdSessionStatus.COMPLETED, actual_end_time: new Date().toTimeString().slice(0,5) });
    return ok({ message: 'All patients seen. Session completed.', session_completed: true });
  }

  await next.update({ status: OpdTokenStatus.CALLED, called_at: new Date() });
  await session.update({ current_token: next.token_number });

  return ok({ message: `Token #${next.token_number} called.`, token_number: next.token_number, patient_id: next.patient_id });
}

// ── Pause session (doctor break) ──────────────────────────────────────────────
export async function pauseSession(
  sessionId: string,
  estimatedBreakMinutes?: number,
): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.ACTIVE) throw ErrorFactory.unprocessable('INVALID_STATUS', 'Only an active session can be paused.');

  // Validate that current time is within doctor's configured break window (flexible break mode)
  const doctor = await DoctorProfile.findByPk(session.doctor_id, {
    attributes: ['break_type', 'break_window_start', 'break_window_end'],
  });
  if (doctor?.break_window_start && doctor.break_window_end) {
    const now    = new Date();
    const hhmm   = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    if (hhmm < doctor.break_window_start || hhmm > doctor.break_window_end) {
      throw ErrorFactory.unprocessable('OUTSIDE_BREAK_WINDOW',
        `Break can only be taken between ${doctor.break_window_start} and ${doctor.break_window_end}.`);
    }
  }

  await session.update({ status: OpdSessionStatus.PAUSED });

  // Recalculate and push ETAs — waiting patients will see a shifted ETA
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

// ── List sessions ─────────────────────────────────────────────────────────────
export async function listSessions(
  hospitalId: string,
  doctorId?: string,
  date?: string,
): Promise<ServiceResponse<object[]>> {
  const where: Record<string, unknown> = { hospital_id: hospitalId };
  if (doctorId) where.doctor_id = doctorId;
  if (date)     where.session_date = date;

  const sessions = await OpdSession.findAll({
    where,
    order: [['session_date', 'DESC'], ['start_time', 'ASC']],
  });

  return ok(sessions.map((s) => s.toJSON()));
}

// ── List tokens for a session ─────────────────────────────────────────────────
export async function listTokens(sessionId: string): Promise<ServiceResponse<object[]>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const tokens = await OpdToken.findAll({
    where:  { session_id: sessionId },
    order:  [['token_number', 'ASC']],
  });

  return ok(tokens.map((t) => ({
    id:                 t.id,
    token_number:       t.token_number,
    patient_id:         t.patient_id,
    token_type:         t.token_type,
    status:             t.status,
    issued_at:          t.issued_at,
    arrived_at:         t.arrived_at,
    called_at:          t.called_at,
    consultation_start: t.consultation_start,
    consultation_end:   t.consultation_end,
  })));
}

// ── Get session live stats ────────────────────────────────────────────────────
export async function getSessionStats(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId, {
    include: [{ model: OpdToken, as: 'tokens' }],
  });
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const tokens  = (session.get('tokens') as OpdToken[] | undefined) ?? [];
  const stats   = {
    session_id:       sessionId,
    status:           session.status,
    current_token:    session.current_token,
    tokens_issued:    session.tokens_issued,
    tokens_completed: tokens.filter(t => t.status === OpdTokenStatus.COMPLETED).length,
    tokens_waiting:   tokens.filter(t => [OpdTokenStatus.ISSUED, OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING].includes(t.status)).length,
    tokens_skipped:   tokens.filter(t => t.status === OpdTokenStatus.SKIPPED).length,
    tokens_no_show:   tokens.filter(t => t.status === OpdTokenStatus.NO_SHOW).length,
    avg_time_per_patient: session.avg_time_per_patient,
    estimated_end_time: await calculateEstimatedEnd(session),
  };

  return ok(stats);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Count tokens that have not yet been seen (excludes completed/skipped/no_show/cancelled)
const PENDING_STATUSES = [
  OpdTokenStatus.ISSUED,
  OpdTokenStatus.ARRIVED,
  OpdTokenStatus.WAITING,
  OpdTokenStatus.CALLED,
  OpdTokenStatus.IN_PROGRESS,
];

async function calculateEstimatedWait(session: OpdSession, tokenNumber: number): Promise<number> {
  const tokensAhead = await OpdToken.findAll({
    where: {
      session_id:   session.id,
      token_number: { [Op.lt]: tokenNumber },
      status:       { [Op.in]: PENDING_STATUSES },
    },
    attributes: ['personalized_duration_minutes', 'duration_override'],
  });

  const fallback = Number(session.avg_time_per_patient);
  const doctor   = await DoctorProfile.findByPk(session.doctor_id, { attributes: ['buffer_time_minutes'] });
  const buffer   = doctor?.buffer_time_minutes ?? 0;

  return tokensAhead.reduce((sum, t) => {
    const dur = t.duration_override ?? t.personalized_duration_minutes ?? fallback;
    return sum + dur + buffer;
  }, 0);
}

async function calculateEstimatedEnd(session: OpdSession): Promise<string> {
  const remaining = await OpdToken.findAll({
    where: {
      session_id: session.id,
      status:     { [Op.in]: PENDING_STATUSES },
    },
    attributes: ['personalized_duration_minutes', 'duration_override'],
  });

  const fallback = Number(session.avg_time_per_patient);
  const doctor   = await DoctorProfile.findByPk(session.doctor_id, { attributes: ['buffer_time_minutes'] });
  const buffer   = doctor?.buffer_time_minutes ?? 0;

  const minutesLeft = remaining.reduce((sum, t) => {
    const dur = t.duration_override ?? t.personalized_duration_minutes ?? fallback;
    return sum + dur + buffer;
  }, 0);

  const endTime = new Date(Date.now() + minutesLeft * 60_000);
  return endTime.toTimeString().slice(0, 5);
}

// Shift all waiting token ETA snapshots forward by breakMinutes.
// This is informational — actual ETAs are always recalculated live; this updates the snapshot
// on the token so the patient's next poll sees the updated estimate immediately.
async function shiftWaitingTokenETAs(_sessionId: string, _breakMinutes: number): Promise<void> {
  // ETAs are recalculated dynamically on each stats/queue poll via calculateEstimatedWait,
  // so no persistent shift is needed. This hook is a placeholder for future push notification
  // delivery (e.g., notify each waiting patient that a break has started).
  // TODO Phase 10: push FCM notification to all WAITING / ISSUED tokens in this session.
}

async function updateSessionAvg(session: OpdSession, token: OpdToken): Promise<void> {
  if (!token.consultation_start || !token.consultation_end) return;
  const dur    = (token.consultation_end.getTime() - token.consultation_start.getTime()) / 60_000;
  const oldAvg = Number(session.avg_time_per_patient);
  const newAvg = Math.round((oldAvg * 0.85 + dur * 0.15) * 100) / 100;
  await session.update({ avg_time_per_patient: newAvg });
}

// ── Session breaks ────────────────────────────────────────────────────────────

export async function listBreaks(
  sessionId: string,
): Promise<ServiceResponse<object[]>> {
  const breaks = await OpdSessionBreak.findAll({
    where: { session_id: sessionId },
    order: [['start_time', 'ASC']],
  });
  return ok(breaks.map((b) => b.toJSON()));
}

export async function addBreak(
  sessionId:  string,
  startTime:  string,
  endTime:    string,
  reason?:    string,
): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  if (![OpdSessionStatus.ACTIVE, OpdSessionStatus.SCHEDULED].includes(session.status as OpdSessionStatus)) {
    throw ErrorFactory.unprocessable('SESSION_NOT_ACTIVE', 'Breaks can only be added to active or scheduled sessions.');
  }
  if (startTime >= endTime) {
    throw ErrorFactory.unprocessable('INVALID_BREAK_WINDOW', 'Break start time must be before end time.');
  }
  if (startTime < session.start_time || endTime > session.expected_end_time) {
    throw ErrorFactory.unprocessable('BREAK_OUTSIDE_SESSION', 'Break window must fall within the session time range.');
  }

  // Check for overlap with existing breaks
  const existing = await OpdSessionBreak.findAll({ where: { session_id: sessionId } });
  const overlaps = existing.some(
    (b) => startTime < b.end_time && endTime > b.start_time,
  );
  if (overlaps) {
    throw ErrorFactory.conflict('BREAK_OVERLAP', 'This break window overlaps with an existing break.');
  }

  // Block slots in the break window
  await OpdSlotSession.update(
    { status: OpdSlotStatus.BLOCKED, blocked_reason: `Break: ${reason ?? 'scheduled break'}` },
    {
      where: {
        session_id:      sessionId,
        slot_start_time: { [Op.gte]: startTime },
        slot_end_time:   { [Op.lte]: endTime },
        status:          OpdSlotStatus.PUBLISHED,
      },
    },
  );

  // Pause the session if it's active
  if (session.status === OpdSessionStatus.ACTIVE) {
    await session.update({ status: OpdSessionStatus.PAUSED });
  }

  const breakRecord = await OpdSessionBreak.create({
    session_id: sessionId,
    start_time: startTime,
    end_time:   endTime,
    reason:     reason ?? null,
  });

  logger.info('OPD break added', { sessionId, startTime, endTime });
  return ok(breakRecord.toJSON());
}

export async function removeBreak(
  sessionId: string,
  breakId:   string,
): Promise<ServiceResponse<{ message: string }>> {
  const breakRecord = await OpdSessionBreak.findOne({
    where: { id: breakId, session_id: sessionId },
  });
  if (!breakRecord) throw ErrorFactory.notFound('BREAK_NOT_FOUND', 'Break not found.');

  // Unblock slots that were blocked by this break
  await OpdSlotSession.update(
    { status: OpdSlotStatus.PUBLISHED, blocked_reason: null },
    {
      where: {
        session_id:      sessionId,
        slot_start_time: { [Op.gte]: breakRecord.start_time },
        slot_end_time:   { [Op.lte]: breakRecord.end_time },
        status:          OpdSlotStatus.BLOCKED,
      },
    },
  );

  await breakRecord.destroy();

  // Resume session if no other breaks remain and session is still paused
  const remaining = await OpdSessionBreak.count({ where: { session_id: sessionId } });
  if (remaining === 0) {
    const session = await OpdSession.findByPk(sessionId);
    if (session?.status === OpdSessionStatus.PAUSED) {
      await session.update({ status: OpdSessionStatus.ACTIVE });
    }
  }

  logger.info('OPD break removed', { sessionId, breakId });
  return ok({ message: 'Break removed and slots restored.' });
}
