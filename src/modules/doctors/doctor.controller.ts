import { Request, Response } from 'express';
import * as DoctorService    from './doctor.service';
import { sendSuccess, sendCreated } from '../../utils/response';
import { JwtAccessPayload, handleResult } from '../../types';

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const qs    = (req: Request, k: string, d = '') => String((req.query as Record<string,string>)[k] ?? d);

export async function registerDoctor(req: Request, res: Response): Promise<void> {
  const result = await DoctorService.registerDoctor(req.body as DoctorService.RegisterDoctorInput);
  handleResult(res, result, (data) => sendCreated(res, data));
}

export async function getDoctorProfile(req: Request, res: Response): Promise<void> {
  const result = await DoctorService.getDoctorProfile(param(req, 'id'));
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function listDoctors(req: Request, res: Response): Promise<void> {
  const page = parseInt(qs(req, 'page', '1'), 10);
  const perPage = parseInt(qs(req, 'per_page', '20'), 10);
  const result = await DoctorService.listDoctors({
    specialization: qs(req,'specialization') || undefined,
    city: qs(req,'city') || undefined,
    hospital_id: qs(req,'hospital_id') || undefined,
    page, perPage,
  });
  handleResult(res, result, (d) => sendSuccess(res, d.rows, 200, {
    total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage),
  }));
}

export async function createSchedule(req: Request, res: Response): Promise<void> {
  const result = await DoctorService.createSchedule(req.body as DoctorService.CreateScheduleInput);
  handleResult(res, result, (data) => sendCreated(res, data));
}

export async function verifyDoctor(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const { action } = req.body as { action: 'approve' | 'reject' };
  const result = await DoctorService.verifyDoctor(param(req, 'id'), user.sub, action);
  handleResult(res, result, (data) => sendSuccess(res, data));
}
