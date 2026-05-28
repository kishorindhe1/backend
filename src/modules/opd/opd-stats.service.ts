import { Op } from 'sequelize';
import {
  OpdSession,
  OpdToken, OpdTokenStatus,
  DoctorProfile, Hospital,
} from '../../models';
import { ErrorFactory }        from '../../utils/errors';
import { ServiceResponse, ok } from '../../types';
import { PENDING_STATUSES, calculateEstimatedEnd } from './opd-helpers';

// ── Get session live stats ────────────────────────────────────────────────────

export async function getSessionStats(sessionId: string): Promise<ServiceResponse<object>> {
  const session = await OpdSession.findByPk(sessionId, {
    include: [{ model: OpdToken, as: 'tokens' }],
  });
  if (!session) throw ErrorFactory.notFound('SESSION_NOT_FOUND', 'Session not found.');

  const tokens = (session.get('tokens') as OpdToken[] | undefined) ?? [];
  const stats  = {
    session_id:           sessionId,
    status:               session.status,
    current_token:        session.current_token,
    tokens_issued:        session.tokens_issued,
    tokens_completed:     tokens.filter((t) => t.status === OpdTokenStatus.COMPLETED).length,
    tokens_waiting:       tokens.filter((t) => [OpdTokenStatus.ISSUED, OpdTokenStatus.ARRIVED, OpdTokenStatus.WAITING].includes(t.status)).length,
    tokens_skipped:       tokens.filter((t) => t.status === OpdTokenStatus.SKIPPED).length,
    tokens_no_show:       tokens.filter((t) => t.status === OpdTokenStatus.NO_SHOW).length,
    avg_time_per_patient: session.avg_time_per_patient,
    estimated_end_time:   await calculateEstimatedEnd(session),
  };

  return ok(stats);
}

// ── Get session public info (no auth) ─────────────────────────────────────────

export async function getSessionPublicInfo(sessionId: string): Promise<ServiceResponse<object>> {
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
