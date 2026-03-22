import { Request, Response } from 'express';
import * as PatientService   from './patient.service';
import { sendSuccess, sendCreated } from '../../utils/response';
import { JwtAccessPayload, handleResult } from '../../types';
import { CompleteProfileInput, UpdateProfileInput } from './patient.validation';

export async function getMyProfile(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const result = await PatientService.getMyProfile(user.sub);
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function completeProfile(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const result = await PatientService.completeProfile(user.sub, req.body as CompleteProfileInput);
  handleResult(res, result, (data) => sendCreated(res, data));
}

export async function updateProfile(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const result = await PatientService.updateProfile(user.sub, req.body as UpdateProfileInput);
  handleResult(res, result, (data) => sendSuccess(res, data));
}
