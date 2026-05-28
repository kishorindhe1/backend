import { Request, Response, NextFunction } from 'express';
import { httpRequestsTotal, httpRequestDuration } from '../config/metrics';

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e9;
    const route = (req.route?.path as string | undefined)
      ? `${req.baseUrl ?? ''}${req.route.path}`
      : req.path;

    const labels = { method: req.method, route, status_code: String(res.statusCode) };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationMs);
  });

  next();
}
