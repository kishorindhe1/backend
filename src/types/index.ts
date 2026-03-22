import { Request } from 'express';

// ── Enums ─────────────────────────────────────────────────────────────────────
export enum UserRole {
  PATIENT       = 'patient',
  DOCTOR        = 'doctor',
  RECEPTIONIST  = 'receptionist',
  HOSPITAL_ADMIN= 'hospital_admin',
  SUPER_ADMIN   = 'super_admin',
}

export enum AccountStatus {
  OTP_VERIFIED = 'otp_verified',
  ACTIVE       = 'active',
  SUSPENDED    = 'suspended',
  DEACTIVATED  = 'deactivated',
}

export enum ProfileStatus {
  INCOMPLETE = 'incomplete',
  COMPLETE   = 'complete',
}

// ── JWT payloads ──────────────────────────────────────────────────────────────
export interface JwtAccessPayload {
  sub:            string;
  jti:            string;
  role:           UserRole;
  account_status: AccountStatus;
  profile_status?: ProfileStatus;
  hospital_id?:   string;
  iat:            number;
  exp:            number;
}

export interface JwtRefreshPayload {
  sub:  string;
  jti:  string;
  type: 'refresh';
  iat:  number;
  exp:  number;
}

// ── Express augmentation ──────────────────────────────────────────────────────
declare global {
  namespace Express {
    interface Request {
      user?:      JwtAccessPayload;
      requestId?: string;
    }
    interface Locals { requestId?: string; }
  }
}

// ── Service result — properly discriminated union ─────────────────────────────
export interface ServiceResult<T> {
  readonly success: true;
  readonly data:    T;
}

export interface ServiceError {
  readonly success:    false;
  readonly code:       string;
  readonly message:    string;
  readonly statusCode: number;
  readonly extra?:     Record<string, unknown>;
}

export type ServiceResponse<T> = ServiceResult<T> | ServiceError;

export function ok<T>(data: T): ServiceResult<T> {
  return { success: true, data } as const;
}

export function fail(
  code:       string,
  message:    string,
  statusCode  = 400,
  extra?:     Record<string, unknown>,
): ServiceError {
  return { success: false, code, message, statusCode, extra } as const;
}

// ── Controller helper — type-narrows and sends HTTP response ──────────────────
import type { Response } from 'express';

export function handleResult<T>(
  res:     Response,
  result:  ServiceResponse<T>,
  onSuccess: (data: T) => void,
): void {
  if (result.success === false) {
    const { statusCode, code, message, extra } = result;
    res.status(statusCode).json({
      success: false,
      error:   { code, message, ...extra },
      request_id: (res.locals as Record<string, unknown>).requestId,
    });
  } else {
    onSuccess(result.data);
  }
}
