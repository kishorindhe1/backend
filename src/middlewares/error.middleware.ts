import { Request, Response, NextFunction } from 'express';
import { StatusCodes } from 'http-status-codes';
import { AppError, isAppError } from '../utils/errors';
import { logger } from '../utils/logger';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorMiddleware(err: Error, req: Request, res: Response, _next: NextFunction): void {
  let statusCode = StatusCodes.INTERNAL_SERVER_ERROR;
  let code       = 'INTERNAL_ERROR';
  let message    = 'An unexpected error occurred. Please try again.';
  let extra: Record<string, unknown> | undefined;

  if (isAppError(err)) {
    statusCode = err.statusCode;
    code       = err.code;
    message    = err.isOperational ? err.message : 'An unexpected error occurred.';
    extra      = err.extra;
  } else if (err.name === 'SequelizeUniqueConstraintError') {
    statusCode = StatusCodes.CONFLICT;
    code       = 'DUPLICATE_RESOURCE';
    message    = 'A resource with these details already exists.';
  } else if (err.name === 'SequelizeValidationError') {
    statusCode = StatusCodes.BAD_REQUEST;
    code       = 'VALIDATION_ERROR';
    message    = err.message;
  } else if (err.name === 'SequelizeForeignKeyConstraintError') {
    statusCode = StatusCodes.CONFLICT;
    code       = 'FOREIGN_KEY_CONSTRAINT';
    message    = 'This operation conflicts with an existing record.';
  }

  const logPayload = {
    requestId: res.locals.requestId,
    method:    req.method,
    path:      req.path,
    statusCode, code,
    userId:    req.user?.sub,
    stack:     err.stack,
  };

  if (statusCode >= StatusCodes.INTERNAL_SERVER_ERROR) {
    logger.error('Unhandled server error', logPayload);
  } else {
    logger.warn('Request error', { ...logPayload, stack: undefined });
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code, message, ...extra,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    },
    request_id: res.locals.requestId,
  });
}

export function notFoundMiddleware(req: Request, res: Response): void {
  res.status(StatusCodes.NOT_FOUND).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
    request_id: res.locals.requestId,
  });
}
