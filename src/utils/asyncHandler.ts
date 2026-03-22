import { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Wraps an async route handler so any thrown error is forwarded to
 * Express's error-handling middleware instead of crashing the process.
 *
 * Usage:
 *   router.get('/route', asyncHandler(myController))
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
