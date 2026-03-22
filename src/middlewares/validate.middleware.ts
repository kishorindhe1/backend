import { Request, Response, NextFunction } from 'express';
import { ZodObject, ZodRawShape, ZodError } from 'zod';
import { sendBadRequest } from '../utils/response';

export function validate(schema: ZodObject<ZodRawShape>) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parsed = await schema.parseAsync({
        body:   req.body,
        params: req.params,
        query:  req.query,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (parsed.body)   req.body   = parsed.body as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (parsed.params) req.params = parsed.params as any;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (parsed.query)  req.query  = parsed.query as any;

      next();
    } catch (err) {
      if (err instanceof ZodError) {
        const issues  = err.issues;
        const details: Record<string, string[]> = {};

        issues.forEach((issue) => {
          const field = issue.path.slice(1).join('.') || issue.path.join('.');
          if (!details[field]) details[field] = [];
          details[field].push(issue.message);
        });

        const firstIssue = issues[0];
        const message    = firstIssue?.message ?? 'Validation failed';

        sendBadRequest(res, 'VALIDATION_ERROR', message, details);
        return;
      }
      next(err);
    }
  };
}
