import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Attaches a unique request ID to every request.
 * Must be the FIRST middleware in the chain — all logs depend on it.
 *
 * - Reads X-Request-ID header if the client sends one (useful for tracing)
 * - Generates a new UUID otherwise
 * - Attaches to req.requestId, res.locals.requestId, and response header
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const existingId = req.headers['x-request-id'];
  const requestId  = typeof existingId === 'string' && existingId.length > 0
    ? existingId
    : uuidv4();

  req.requestId          = requestId;
  res.locals.requestId   = requestId;
  res.setHeader('X-Request-ID', requestId);

  next();
}
