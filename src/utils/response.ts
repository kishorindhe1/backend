import { Response } from 'express';

// ── Types ────────────────────────────────────────────────────────────────────
export interface PaginationMeta {
  total: number;
  page: number;
  per_page: number;
  total_pages: number;
}

export interface ApiError {
  code: string;
  message: string;
  field?: string;
  details?: Record<string, string[]>;
  [key: string]: unknown;
}

// ── Success response ─────────────────────────────────────────────────────────
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: PaginationMeta,
): void {
  const body: Record<string, unknown> = {
    success: true,
    data,
    request_id: res.locals.requestId,
  };
  if (meta) body.meta = meta;
  res.status(statusCode).json(body);
}

// ── Created response (201) ───────────────────────────────────────────────────
export function sendCreated<T>(res: Response, data: T): void {
  sendSuccess(res, data, 201);
}

// ── No content (204) ─────────────────────────────────────────────────────────
export function sendNoContent(res: Response): void {
  res.status(204).send();
}

// ── Error response ───────────────────────────────────────────────────────────
export function sendError(
  res: Response,
  statusCode: number,
  error: ApiError,
): void {
  res.status(statusCode).json({
    success: false,
    error,
    request_id: res.locals.requestId,
  });
}

// ── Shorthand error senders ──────────────────────────────────────────────────
export function sendBadRequest(res: Response, code: string, message: string, details?: Record<string, string[]>): void {
  sendError(res, 400, { code, message, ...(details && { details }) });
}

export function sendUnauthorized(res: Response, code = 'AUTH_TOKEN_INVALID', message = 'Unauthorized'): void {
  sendError(res, 401, { code, message });
}

export function sendForbidden(res: Response, code: string, message: string, extra?: Record<string, unknown>): void {
  sendError(res, 403, { code, message, ...extra });
}

export function sendNotFound(res: Response, code: string, message: string): void {
  sendError(res, 404, { code, message });
}

export function sendConflict(res: Response, code: string, message: string, extra?: Record<string, unknown>): void {
  sendError(res, 409, { code, message, ...extra });
}

export function sendTooManyRequests(res: Response, code: string, message: string, retryAfter?: number): void {
  sendError(res, 429, { code, message, ...(retryAfter !== undefined && { retry_after: retryAfter }) });
}

export function sendInternalError(res: Response): void {
  sendError(res, 500, {
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred. Please try again.',
  });
}

// ── Pagination builder ───────────────────────────────────────────────────────
export function buildPaginationMeta(total: number, page: number, perPage: number): PaginationMeta {
  return {
    total,
    page,
    per_page: perPage,
    total_pages: Math.ceil(total / perPage),
  };
}
