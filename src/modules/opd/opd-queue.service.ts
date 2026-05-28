import { Op } from 'sequelize';
import {
  OpdSession, OpdSessionStatus,
  OpdSessionBreak,
  OpdSlotSession, OpdSlotStatus,
} from '../../models';
import { ErrorFactory }  from '../../utils/errors';
import { ServiceResponse, ok } from '../../types';
import { logger }        from '../../utils/logger';

// ── List breaks for a session ─────────────────────────────────────────────────

export async function listBreaks(sessionId: string): Promise<ServiceResponse<object[]>> {
  const breaks = await OpdSessionBreak.findAll({
    where: { session_id: sessionId },
    order: [['start_time', 'ASC']],
  });
  return ok(breaks.map((b) => b.toJSON()));
}

// ── Add a break to a session ──────────────────────────────────────────────────

export async function addBreak(
  sessionId: string,
  startTime: string,
  endTime:   string,
  reason?:   string,
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

  const existing = await OpdSessionBreak.findAll({ where: { session_id: sessionId } });
  const overlaps = existing.some((b) => startTime < b.end_time && endTime > b.start_time);
  if (overlaps) {
    throw ErrorFactory.conflict('BREAK_OVERLAP', 'This break window overlaps with an existing break.');
  }

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

// ── Remove a break from a session ─────────────────────────────────────────────

export async function removeBreak(
  sessionId: string,
  breakId:   string,
): Promise<ServiceResponse<{ message: string }>> {
  const breakRecord = await OpdSessionBreak.findOne({
    where: { id: breakId, session_id: sessionId },
  });
  if (!breakRecord) throw ErrorFactory.notFound('BREAK_NOT_FOUND', 'Break not found.');

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
