import { Request, Response } from 'express';
import * as AuthService       from './auth.service';
import { sendSuccess, sendCreated } from '../../utils/response';
import { JwtAccessPayload, handleResult } from '../../types';

export async function requestOtp(req: Request, res: Response): Promise<void> {
  const { mobile, country_code } = req.body as { mobile: string; country_code?: string };
  const result = await AuthService.requestOtp(mobile, country_code);
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function verifyOtp(req: Request, res: Response): Promise<void> {
  const { mobile, otp } = req.body as { mobile: string; otp: string };
  const result = await AuthService.verifyOtp(mobile, otp);
  handleResult(res, result, (data) => sendCreated(res, data));
}

export async function refreshToken(req: Request, res: Response): Promise<void> {
  const { refresh_token } = req.body as { refresh_token: string };
  const result = await AuthService.refreshAccessToken(refresh_token);
  handleResult(res, result, (data) => sendSuccess(res, data));
}

export async function logout(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const result = await AuthService.logout(user.jti, user.exp, user.sub);
  handleResult(res, result, (data) => sendSuccess(res, data));
}
