import { Op } from 'sequelize';
import { redis }                        from '../../config/redis';
import {
  OpdSession, OpdSessionStatus,
  OpdToken, OpdTokenType, OpdTokenStatus,
  Appointment, AppointmentStatus, AppointmentType, PaymentMode, PaymentStatus,
  ConsultationQueue, QueueStatus,
  DoctorHospitalAffiliation,
  DoctorProfile, Hospital,
  User, PatientProfile,
  NotificationChannel,
} from '../../models';
import { ErrorFactory }                 from '../../utils/errors';
import { ServiceResponse, ok }          from '../../types';
import { logger }                       from '../../utils/logger';
import { istDate }                      from '../../utils/dateTime';
import { emit, OpdRooms, OpdEvents }    from '../../config/socket';
import { enqueueNotification }          from '../notifications/notification.service';
import { getEffectiveDuration }         from '../duration/duration.service';
import { PENDING_STATUSES, calculateEstimatedWait, updateSessionAvg } from './opd-helpers';
import { sendReceiptEmailForAppointment } from '../payments/payment.service';

// ── Issue online token ────────────────────────────────────────────────────────

export async function issueOnlineToken(
  sessionId:      string,
  patientId:      string,
  appointmentId?: string,
): Promise<ServiceResponse<{ token_number: number; estimated_wait_minutes: number; session_id: string }>> {
  const lockKey  = `lock:opd:token:${sessionId}`;
  const acquired = await redis.set(lockKey, '1', 'EX', 5, 'NX');
  if (!acquired) throw ErrorFactory.conflict('TOKEN_LOCK', 'Token issuance in progress, please retry.');

  try {
    const session = await OpdSession.findByPk(sessionId);
    if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'OPD session not found.');
    if (session.status === OpdSessionStatus.CANCELLED) throw ErrorFactory.unprocessable('SESSION_CANCELLED', 'This session has been cancelled.');
    if (session.tokens_issued >= session.total_tokens) throw ErrorFactory.conflict('TOKENS_FULL', 'This session is fully booked.');

    const tokenNumber      = session.tokens_issued + 1;
    await session.update({ tokens_issued: tokenNumber });

    const durationSnapshot = await getEffectiveDuration(patientId, session.doctor_id);

    await OpdToken.create({
      session_id:                    sessionId,
      token_number:                  tokenNumber,
      patient_id:                    patientId,
      appointment_id:                appointmentId ?? null,
      token_type:                    OpdTokenType.ONLINE,
      issued_by:                     'online_booking',
      arrived_at:                    null,
      called_at:                     null,
      consultation_start:            null,
      consultation_end:              null,
      status:                        OpdTokenStatus.ISSUED,
      personalized_duration_minutes: durationSnapshot,
      duration_override:             null,
    });

    const estimatedWait = await calculateEstimatedWait(session, tokenNumber);
    logger.info('OPD token issued', { sessionId, tokenNumber, patientId });
    return ok({ token_number: tokenNumber, estimated_wait_minutes: estimatedWait, session_id: sessionId });
  } finally {
    await redis.del(lockKey);
  }
}

// ── Issue walk-in token (receptionist) ───────────────────────────────────────

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
    session_id:     sessionId,
    token_number:   totalIssued,
    patient_id:     patientId,
    appointment_id: null,
    token_type:     OpdTokenType.WALKIN,
    issued_by:      issuedBy,
    arrived_at:     new Date(),
    called_at:      null,
    consultation_start: null,
    consultation_end:   null,
    status:         OpdTokenStatus.ARRIVED,
  });

  return ok({ token_number: token.token_number });
}

// ── Patient joins queue via QR scan ──────────────────────────────────────────

export async function joinAsWalkin(
  sessionId: string,
  patientId: string,
): Promise<ServiceResponse<{ token_number: number; estimated_wait_minutes: number; session_id: string; doctor_name: string; appointment_id: string }>> {
  const lockKey  = `lock:opd:token:${sessionId}`;
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

    const existing = await OpdToken.findOne({
      where: {
        session_id: sessionId,
        patient_id: patientId,
        status: { [Op.notIn]: [OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW] },
      },
    });
    if (existing) {
      if (existing.status === OpdTokenStatus.ISSUED) {
        await existing.update({ status: OpdTokenStatus.ARRIVED, arrived_at: new Date() });
        const estimatedWait = await calculateEstimatedWait(session, existing.token_number);
        const doctor        = session.get('doctor') as DoctorProfile | undefined;
        logger.info('Late check-in: ISSUED token re-activated', { sessionId, patientId, tokenNumber: existing.token_number });
        return ok({
          token_number:           existing.token_number,
          estimated_wait_minutes: estimatedWait,
          session_id:             sessionId,
          doctor_name:            doctor?.full_name ?? 'Doctor',
          appointment_id:         existing.appointment_id ?? '',
          late_arrival:           true,
        });
      }
      throw ErrorFactory.conflict('ALREADY_IN_QUEUE', `You already have token #${existing.token_number} in this session.`);
    }

    const totalIssued      = session.tokens_issued + 1;
    await session.update({ tokens_issued: totalIssued });

    const durationSnapshot = await getEffectiveDuration(patientId, session.doctor_id);

    const affiliation = await DoctorHospitalAffiliation.findOne({
      where: { doctor_id: session.doctor_id, hospital_id: session.hospital_id, is_active: true },
      attributes: ['consultation_fee'],
    });
    const fee = parseFloat(String(affiliation?.consultation_fee ?? 0));

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

    const queueDate   = istDate();
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

// ── Call next token ───────────────────────────────────────────────────────────

export async function callNextToken(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');
  if (session.status !== OpdSessionStatus.ACTIVE) throw ErrorFactory.unprocessable('SESSION_NOT_ACTIVE', 'Session is not active.');

  const completing = await OpdToken.findOne({
    where: { session_id: sessionId, status: { [Op.in]: [OpdTokenStatus.CALLED, OpdTokenStatus.IN_PROGRESS] } },
  });
  if (completing) {
    const now          = new Date();
    const consultStart = completing.consultation_start ?? completing.called_at ?? now;
    await completing.update({ status: OpdTokenStatus.COMPLETED, consultation_end: now });
    if (completing.appointment_id) {
      await Appointment.update({ status: AppointmentStatus.COMPLETED }, { where: { id: completing.appointment_id } });
      sendReceiptEmailForAppointment(completing.appointment_id)
        .catch((err) => logger.warn('Receipt email after token completion failed', { appointmentId: completing.appointment_id, err }));
    }
    await updateSessionAvg(session, { ...completing.toJSON(), consultation_start: consultStart, consultation_end: now } as any);
  }

  const next = await OpdToken.findOne({
    where: { session_id: sessionId, status: { [Op.in]: [OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING] } },
    order: [['token_number', 'ASC']],
  });

  if (!next) {
    const pendingCount = await OpdToken.count({
      where: {
        session_id: sessionId,
        status: { [Op.notIn]: [OpdTokenStatus.COMPLETED, OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW, OpdTokenStatus.SKIPPED] },
      },
    });
    if (pendingCount > 0) {
      return ok({ message: 'No patients currently waiting.', session_completed: false, current_token: session.current_token });
    }
    const { istTime } = await import('../../utils/dateTime');
    const endTime     = istTime();
    await session.update({ status: OpdSessionStatus.COMPLETED, actual_end_time: endTime });
    emit(OpdRooms.hospital(session.hospital_id), OpdEvents.SESSION_ENDED, { session_id: sessionId, actual_end_time: endTime });
    return ok({ message: 'All patients seen. Session completed.', session_completed: true });
  }

  await next.update({ status: OpdTokenStatus.CALLED, called_at: new Date() });
  await session.update({ current_token: next.token_number });

  const tokenCalledPayload = {
    session_id:   sessionId,
    token_number: next.token_number,
    patient_id:   next.patient_id,
    called_at:    new Date().toISOString(),
  };
  emit(OpdRooms.session(sessionId),            OpdEvents.TOKEN_CALLED,  tokenCalledPayload);
  emit(OpdRooms.hospital(session.hospital_id), OpdEvents.QUEUE_UPDATED, tokenCalledPayload);
  if (next.patient_id) {
    emit(OpdRooms.patient(next.patient_id), OpdEvents.TOKEN_CALLED, tokenCalledPayload);
  }

  // Fan out to every still-waiting patient's personal room — the patient app
  // can't join the staff-only hospital room; it listens in its own room.
  const stillWaiting = await OpdToken.findAll({
    where: {
      session_id: sessionId,
      status:     { [Op.in]: [OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING] },
      patient_id: { [Op.ne]: null },
    },
    attributes: ['patient_id'],
  });
  for (const t of stillWaiting) {
    emit(OpdRooms.patient(t.patient_id!), OpdEvents.QUEUE_UPDATED, tokenCalledPayload);
  }

  if (next.patient_id) {
    const [doctor, hospital] = await Promise.all([
      DoctorProfile.findByPk(session.doctor_id, { attributes: ['full_name'] }),
      Hospital.findByPk(session.hospital_id,    { attributes: ['name'] }),
    ]);
    const patient = await User.findByPk(next.patient_id, {
      attributes: ['mobile'],
      include:    [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'], required: false }],
    });
    const patientName = (patient?.get('patientProfile') as PatientProfile | undefined)?.full_name ?? 'Patient';
    enqueueNotification({
      userId:   next.patient_id,
      type:     'token_called',
      channels: [NotificationChannel.PUSH, NotificationChannel.SMS],
      priority: 'critical',
      data: {
        name:     patientName,
        token:    String(next.token_number),
        doctor:   doctor?.full_name ?? 'Doctor',
        hospital: hospital?.name    ?? 'Hospital',
      },
    }).catch(() => {});
  }

  return ok({ message: `Token #${next.token_number} called.`, token_number: next.token_number, patient_id: next.patient_id });
}

// ── Mark a specific token as complete (receptionist override) ─────────────────

export async function markTokenComplete(
  sessionId: string,
  tokenId:   string,
): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const token = await OpdToken.findOne({ where: { id: tokenId, session_id: sessionId } });
  if (!token) throw ErrorFactory.notFound('TOKEN_NOT_FOUND', 'Token not found in this session.');

  const MARKABLE = [
    OpdTokenStatus.CALLED, OpdTokenStatus.IN_PROGRESS,
    OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING, OpdTokenStatus.ISSUED,
  ];
  if (!MARKABLE.includes(token.status)) {
    throw ErrorFactory.unprocessable('INVALID_STATUS', `Token is already ${token.status}.`);
  }

  const now          = new Date();
  const consultStart = token.consultation_start ?? token.called_at ?? now;
  await token.update({
    status:             OpdTokenStatus.COMPLETED,
    consultation_start: token.consultation_start ?? consultStart,
    consultation_end:   now,
  });
  if (token.appointment_id) {
    await Appointment.update({ status: AppointmentStatus.COMPLETED }, { where: { id: token.appointment_id } });
    sendReceiptEmailForAppointment(token.appointment_id)
      .catch((err) => logger.warn('Receipt email after manual token completion failed', { appointmentId: token.appointment_id, err }));
  }
  await updateSessionAvg(session, { ...token.toJSON(), consultation_start: consultStart, consultation_end: now } as any);

  const remaining = await OpdToken.count({
    where: {
      session_id: sessionId,
      status: { [Op.notIn]: [OpdTokenStatus.COMPLETED, OpdTokenStatus.CANCELLED, OpdTokenStatus.NO_SHOW, OpdTokenStatus.SKIPPED] },
    },
  });
  if (remaining === 0) {
    const { istTime } = await import('../../utils/dateTime');
    await session.update({ status: OpdSessionStatus.COMPLETED, actual_end_time: istTime() });
    emit(OpdRooms.hospital(session.hospital_id), OpdEvents.SESSION_ENDED, { session_id: sessionId });
  }

  logger.info('Token manually marked complete', { sessionId, tokenId });
  return ok({ token_id: tokenId, status: OpdTokenStatus.COMPLETED });
}

// ── List tokens for a session ─────────────────────────────────────────────────

export async function listTokens(sessionId: string): Promise<ServiceResponse<object[]>> {
  const session = await OpdSession.findByPk(sessionId);
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const tokens = await OpdToken.findAll({
    where:  { session_id: sessionId },
    order:  [['token_number', 'ASC']],
    include: [{
      model:      User,
      as:         'patient',
      attributes: ['mobile'],
      required:   false,
      include:    [{ model: PatientProfile, as: 'patientProfile', attributes: ['full_name'], required: false }],
    }],
  });

  return ok(tokens.map((t) => {
    const user   = t.get('patient') as (User & { patientProfile?: PatientProfile }) | undefined;
    const name   = (user?.get('patientProfile') as PatientProfile | undefined)?.full_name ?? null;
    const mobile = user?.mobile ?? null;
    return {
      id:                 t.id,
      token_number:       t.token_number,
      patient_id:         t.patient_id,
      patient_name:       name,
      patient_mobile:     mobile,
      token_type:         t.token_type,
      status:             t.status,
      issued_at:          t.issued_at,
      arrived_at:         t.arrived_at,
      called_at:          t.called_at,
      consultation_start: t.consultation_start,
      consultation_end:   t.consultation_end,
    };
  }));
}
