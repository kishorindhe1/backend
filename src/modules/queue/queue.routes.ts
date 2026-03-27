import { Router, Request, Response } from 'express';
import * as QueueService             from './queue.service';
import { authenticate }              from '../../middlewares/auth.middleware';
import { sendSuccess, sendError }    from '../../utils/response';
import { JwtAccessPayload }          from '../../types';
import { asyncHandler }              from '../../utils/asyncHandler';
import { z }                         from 'zod';
import { validate }                  from '../../middlewares/validate.middleware';

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const qs    = (req: Request, k: string, d = '') => String((req.query as Record<string,string>)[k] ?? d);

// ── Controllers ───────────────────────────────────────────────────────────────
async function getQueueStatus(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await QueueService.getQueueStatus(param(req, 'appointmentId'), user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getDoctorDayQueue(req: Request, res: Response): Promise<void> {
  const result = await QueueService.getDoctorDayQueue(
    param(req, 'doctorId'),
    param(req, 'hospitalId'),
    qs(req, 'date', new Date().toISOString().split('T')[0]),
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

// ── Validation ────────────────────────────────────────────────────────────────
const QueueStatusSchema = z.object({ params: z.object({ appointmentId: z.string().uuid() }) });
const DoctorQueueSchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  query:  z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }),
});

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// Patient — own queue position
router.get('/status/:appointmentId',
  authenticate,
  validate(QueueStatusSchema),
  asyncHandler(getQueueStatus),
);

// Public — hospital-wide display (all doctors today)
router.get('/display/hospital/:hospitalId',
  asyncHandler(async (req: Request, res: Response) => {
    const result = await QueueService.getHospitalQueueDisplay(param(req, 'hospitalId'));
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Public — single doctor display (no auth, no PII) — must be before /:doctorId/:hospitalId
router.get('/display/:doctorId/:hospitalId',
  validate(DoctorQueueSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await QueueService.getQueueDisplay(
      param(req, 'doctorId'),
      param(req, 'hospitalId'),
    );
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Doctor / Receptionist — full day queue
router.get('/:doctorId/:hospitalId',
  authenticate,
  validate(DoctorQueueSchema),
  asyncHandler(getDoctorDayQueue),
);

export default router;
