import { Router, Request, Response } from 'express';
import * as AdminService              from './admin.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendError }     from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';

const ADMINS = [UserRole.SUPER_ADMIN];
const OPS    = [UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN];

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const qs    = (req: Request, k: string, d = '') => String((req.query as Record<string,string>)[k] ?? d);

const ToggleSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ action: z.enum(['suspend', 'reactivate']) }),
});
const PeriodSchema = z.object({
  query: z.object({ period: z.enum(['today', 'week', 'month']).default('today') }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function dashboard(req: Request, res: Response): Promise<void> {
  const result = await AdminService.getPlatformHealth();
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function alerts(req: Request, res: Response): Promise<void> {
  const result = await AdminService.getOperationsAlerts();
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function financialSummary(req: Request, res: Response): Promise<void> {
  const period = (qs(req, 'period', 'today')) as 'today' | 'week' | 'month';
  const result = await AdminService.getFinancialSummary(period);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function listDoctors(req: Request, res: Response): Promise<void> {
  const page    = parseInt(qs(req, 'page', '1'), 10);
  const perPage = parseInt(qs(req, 'per_page', '20'), 10);
  const result  = await AdminService.listDoctors({ verification_status: qs(req, 'verification_status') || undefined, page, perPage });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { rows: object[]; count: number };
  sendSuccess(res, d.rows, 200, { total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage) });
}

async function toggleDoctor(req: Request, res: Response): Promise<void> {
  const user   = req.user as import('../../types').JwtAccessPayload;
  const { action } = req.body as { action: 'suspend' | 'reactivate' };
  const result = await AdminService.toggleDoctorStatus(param(req, 'id'), action, user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function recomputeScores(req: Request, res: Response): Promise<void> {
  const result = await AdminService.computeReliabilityScores();
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();
router.use(authenticate, requireRole(...OPS));

router.get  ('/dashboard',                asyncHandler(dashboard));
router.get  ('/alerts',                   asyncHandler(alerts));
router.get  ('/financial', validate(PeriodSchema), asyncHandler(financialSummary));
router.get  ('/doctors',                  asyncHandler(listDoctors));
router.patch('/doctors/:id/status',       requireRole(...ADMINS), validate(ToggleSchema), asyncHandler(toggleDoctor));
router.post ('/reliability/recompute',    requireRole(...ADMINS), asyncHandler(recomputeScores));

export default router;
