import { Op } from 'sequelize';
import { OpdSession, OpdToken, OpdTokenStatus, DoctorProfile } from '../../models';

export const PENDING_STATUSES = [
  OpdTokenStatus.ISSUED,
  OpdTokenStatus.ARRIVED,
  OpdTokenStatus.WAITING,
  OpdTokenStatus.CALLED,
  OpdTokenStatus.IN_PROGRESS,
];

export async function calculateEstimatedWait(session: OpdSession, tokenNumber: number): Promise<number> {
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

export async function calculateEstimatedEnd(session: OpdSession): Promise<string> {
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

export async function updateSessionAvg(session: OpdSession, token: OpdToken): Promise<void> {
  if (!token.consultation_start || !token.consultation_end) return;
  const dur    = (token.consultation_end.getTime() - token.consultation_start.getTime()) / 60_000;
  const oldAvg = Number(session.avg_time_per_patient);
  const newAvg = Math.round((oldAvg * 0.85 + dur * 0.15) * 100) / 100;
  await session.update({ avg_time_per_patient: newAvg });
}

// Placeholder for Phase 10: push FCM to all WAITING/ISSUED tokens when a break starts.
export async function shiftWaitingTokenETAs(_sessionId: string, _breakMinutes: number): Promise<void> {}

export function dateToDayOfWeek(date: string): string {
  const days = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
  return days[new Date(date + 'T12:00:00').getDay()];
}

export function addMinutesToTime(startTime: string, minutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60) % 24).padStart(2,'0')}:${String(total % 60).padStart(2,'0')}`;
}
