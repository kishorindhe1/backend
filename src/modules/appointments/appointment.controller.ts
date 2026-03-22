import { Request, Response } from 'express';
import * as AppointmentService from './appointment.service';
import { sendSuccess, sendCreated } from '../../utils/response';
import { JwtAccessPayload, handleResult } from '../../types';
import { CancellationBy } from '../../models';

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const qs    = (req: Request, k: string, d: string) => String((req.query as Record<string,string>)[k] ?? d);

export async function bookAppointment(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const { doctor_id, hospital_id, slot_id, notes, appointment_type } = req.body as Record<string,string>;
  const result = await AppointmentService.bookAppointment({ patient_id: user.sub, doctor_id, hospital_id, slot_id, notes });
  handleResult(res, result, (data) => sendCreated(res, data));
}

export async function getAppointment(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const result = await AppointmentService.getAppointment(param(req, 'id'), user.sub);
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function cancelAppointment(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const { reason } = req.body as { reason?: string };
  const result = await AppointmentService.cancelAppointment(param(req, 'id'), user.sub, CancellationBy.PATIENT, reason);
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function getMyAppointments(req: Request, res: Response): Promise<void> {
  const user    = req.user as JwtAccessPayload;
  const page    = parseInt(qs(req, 'page', '1'), 10);
  const perPage = parseInt(qs(req, 'per_page', '20'), 10);
  const result  = await AppointmentService.getPatientAppointments(user.sub, page, perPage);
  handleResult(res, result, (d) => sendSuccess(res, d.rows, 200, {
    total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage),
  }));
}
