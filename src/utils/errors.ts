import { StatusCodes } from 'http-status-codes';

// ── Base application error ────────────────────────────────────────────────────
export class AppError extends Error {
  public readonly statusCode:    number;
  public readonly code:          string;
  public readonly isOperational: boolean;
  public readonly extra?:        Record<string, unknown>;

  constructor(
    code:          string,
    message:       string,
    statusCode:    number,
    isOperational  = true,
    extra?:        Record<string, unknown>,
  ) {
    super(message);
    this.name          = 'AppError';
    this.code          = code;
    this.statusCode    = statusCode;
    this.isOperational = isOperational;
    this.extra         = extra;
    Error.captureStackTrace(this, this.constructor);
  }
}

// ── ErrorFactory ──────────────────────────────────────────────────────────────
export const ErrorFactory = {

  badRequest(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.BAD_REQUEST, true, extra);
  },

  unauthorized(code = 'AUTH_TOKEN_INVALID', message = 'Unauthorized'): AppError {
    return new AppError(code, message, StatusCodes.UNAUTHORIZED);
  },

  forbidden(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.FORBIDDEN, true, extra);
  },

  notFound(code: string, message: string): AppError {
    return new AppError(code, message, StatusCodes.NOT_FOUND);
  },

  conflict(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.CONFLICT, true, extra);
  },

  unprocessable(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.UNPROCESSABLE_ENTITY, true, extra);
  },

  locked(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.LOCKED, true, extra);
  },

  tooManyRequests(code: string, message: string, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, StatusCodes.TOO_MANY_REQUESTS, true, extra);
  },

  // isOperational = false: internal errors — message is NOT shown to client
  internal(message = 'An unexpected error occurred'): AppError {
    return new AppError('INTERNAL_ERROR', message, StatusCodes.INTERNAL_SERVER_ERROR, false);
  },

  serviceUnavailable(code: string, message: string): AppError {
    return new AppError(code, message, StatusCodes.SERVICE_UNAVAILABLE);
  },

  custom(code: string, message: string, statusCode: number, extra?: Record<string, unknown>): AppError {
    return new AppError(code, message, statusCode, true, extra);
  },
} as const;

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}
