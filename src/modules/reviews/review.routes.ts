import { Router, Request, Response } from 'express';
import * as ReviewService            from './review.service';
import { authenticate }              from '../../middlewares/auth.middleware';
import { validate }                  from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload }          from '../../types';
import { asyncHandler }              from '../../utils/asyncHandler';
import { z }                         from 'zod';

const qs = (req: Request, k: string, d = '') => String((req.query as Record<string, string>)[k] ?? d);

const CreateReviewSchema = z.object({
  body: z.object({
    doctor_id:      z.string().uuid(),
    appointment_id: z.string().uuid(),
    rating:         z.number().int().min(1).max(5),
    comment:        z.string().max(1000).optional(),
  }),
});

const ListReviewsSchema = z.object({
  query: z.object({
    doctor_id: z.string().uuid(),
    page:      z.string().default('1').transform(Number),
    per_page:  z.string().default('20').transform(Number),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function createReview(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const { doctor_id, appointment_id, rating, comment } = req.body as {
    doctor_id: string; appointment_id: string; rating: number; comment?: string;
  };
  const result = await ReviewService.createReview({ patient_id: user.sub, doctor_id, appointment_id, rating, comment });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function getDoctorReviews(req: Request, res: Response): Promise<void> {
  const doctorId = qs(req, 'doctor_id');
  const page     = parseInt(qs(req, 'page', '1'), 10);
  const perPage  = Math.min(50, parseInt(qs(req, 'per_page', '20'), 10));
  const result   = await ReviewService.getDoctorReviews(doctorId, page, perPage);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { rows: object[]; count: number };
  sendSuccess(res, d.rows, 200, { total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage) });
}

async function getMyReviews(req: Request, res: Response): Promise<void> {
  const user    = req.user as JwtAccessPayload;
  const page    = parseInt(qs(req, 'page', '1'), 10);
  const perPage = Math.min(50, parseInt(qs(req, 'per_page', '20'), 10));
  const result  = await ReviewService.getMyReviews(user.sub, page, perPage);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { rows: object[]; count: number };
  sendSuccess(res, d.rows, 200, { total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage) });
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

router.get('/',    validate(ListReviewsSchema), asyncHandler(getDoctorReviews));  // public
router.use(authenticate);
router.post('/',   validate(CreateReviewSchema), asyncHandler(createReview));
router.get('/my',  asyncHandler(getMyReviews));

export default router;
