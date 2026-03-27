import { Router, Request, Response } from 'express';
import * as NotificationService        from './notification.service';
import { authenticate }               from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendError, sendCreated } from '../../utils/response';
import { JwtAccessPayload }            from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';

const qs = (req: Request, k: string, d: string) => String((req.query as Record<string,string>)[k] ?? d);

const DeviceTokenSchema = z.object({
  body: z.object({
    fcm_token: z.string().min(1),
  }),
});

const PrefsSchema = z.object({
  body: z.object({
    sms_enabled:              z.boolean().optional(),
    push_enabled:             z.boolean().optional(),
    email_enabled:            z.boolean().optional(),
    booking_reminders:        z.boolean().optional(),
    delay_alerts:             z.boolean().optional(),
    queue_position_alerts:    z.boolean().optional(),
    quiet_hours_enabled:      z.boolean().optional(),
    quiet_hours_start:        z.string().regex(/^\d{2}:\d{2}$/).optional(),
    quiet_hours_end:          z.string().regex(/^\d{2}:\d{2}$/).optional(),
    reminder_lead_time_hours: z.number().int().min(1).max(48).optional(),
    queue_notify_at_position: z.number().int().min(1).max(10).optional(),
  }),
});

async function updatePreferences(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await NotificationService.updatePreferences(user.sub, req.body);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getHistory(req: Request, res: Response): Promise<void> {
  const user    = req.user as JwtAccessPayload;
  const page    = parseInt(qs(req, 'page',     '1'),  10);
  const perPage = parseInt(qs(req, 'per_page', '20'), 10);
  const result  = await NotificationService.getNotificationHistory(user.sub, page, perPage);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { rows: object[]; count: number };
  sendSuccess(res, d.rows, 200, { total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage) });
}

const router = Router();
router.use(authenticate);

router.put ('/device-token',   validate(DeviceTokenSchema), asyncHandler(async (req, res) => {
  const user   = req.user as JwtAccessPayload;
  const result = await NotificationService.registerDeviceToken(user.sub, req.body.fcm_token);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));
router.get ('/preferences',    asyncHandler(async (req, res) => {
  const user   = req.user as JwtAccessPayload;
  const result = await NotificationService.getPreferences(user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));
router.put ('/preferences',    validate(PrefsSchema), asyncHandler(updatePreferences));
router.get ('/history',        asyncHandler(getHistory));

export default router;
