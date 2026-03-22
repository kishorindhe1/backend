import { Router, Request, Response } from 'express';
import * as PaymentService   from './payment.service';
import { authenticate }       from '../../middlewares/auth.middleware';
import { validate }           from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload }   from '../../types';
import { asyncHandler }       from '../../utils/asyncHandler';
import { z }                  from 'zod';

// ── Validation ────────────────────────────────────────────────────────────────
const InitiateSchema = z.object({
  body: z.object({ appointment_id: z.string().uuid() }),
});

const VerifySchema = z.object({
  body: z.object({
    razorpay_order_id:   z.string(),
    razorpay_payment_id: z.string(),
    razorpay_signature:  z.string(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function initiatePayment(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const { appointment_id } = req.body as { appointment_id: string };
  const result = await PaymentService.initiatePayment(appointment_id, user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function verifyPayment(req: Request, res: Response): Promise<void> {
  const result = await PaymentService.verifyPayment(req.body as {
    razorpay_order_id: string;
    razorpay_payment_id: string;
    razorpay_signature: string;
  });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

// Webhook — uses raw body parser mounted in app.ts
async function razorpayWebhook(req: Request, res: Response): Promise<void> {
  const signature = req.headers['x-razorpay-signature'] as string ?? '';
  const rawBody   = req.body as Buffer;
  let payload: Record<string, unknown>;

  try {
    payload = JSON.parse(rawBody.toString());
  } catch {
    res.status(400).json({ success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON payload' } });
    return;
  }

  const result = await PaymentService.handleWebhook(rawBody, signature, payload);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  // Always 200 to Razorpay
  res.status(200).json({ success: true, data: result.data });
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

router.post('/initiate',   authenticate, validate(InitiateSchema), asyncHandler(initiatePayment));
router.post('/verify',     authenticate, validate(VerifySchema),   asyncHandler(verifyPayment));
router.post('/webhook/razorpay', asyncHandler(razorpayWebhook));   // no auth — Razorpay calls this

export default router;
