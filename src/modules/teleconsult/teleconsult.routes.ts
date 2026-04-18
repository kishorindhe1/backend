import { Router, Request, Response } from 'express';
import * as TeleconsultService        from './teleconsult.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendError }     from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { SlotType }                   from '../../models';
import { z }                          from 'zod';

const dateRegex = /^\d{4}-\d{2}-\d{2}$/;

const ConvertSchema = z.object({
  params: z.object({ slotId: z.string().uuid() }),
});

const SetTypeForDateSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid(),
    hospital_id: z.string().uuid(),
    date:        z.string().regex(dateRegex),
    slot_type:   z.nativeEnum(SlotType),
  }),
});

const GetLinkSchema = z.object({
  params: z.object({ appointmentId: z.string().uuid() }),
});

const router = Router();
const STAFF = [UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN, UserRole.RECEPTIONIST];

// Convert single slot to teleconsult
router.patch(
  '/slots/:slotId/convert',
  authenticate,
  requireRole(...STAFF),
  validate(ConvertSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { slotId } = req.params as { slotId: string };
    const hospitalId  = ((req as any).user.hospital_id ?? '') as string;
    const requestedBy = (req as any).user.sub as string;
    const result = await TeleconsultService.convertToTeleconsult(slotId, hospitalId, requestedBy);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Bulk set slot type for a doctor+date
router.post(
  '/set-type',
  authenticate,
  requireRole(...STAFF),
  validate(SetTypeForDateSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const body = req.body as { doctor_id: string; hospital_id: string; date: string; slot_type: SlotType };
    const requestedBy = (req as any).user.sub as string;
    const result = await TeleconsultService.setSlotTypeForDate({ doctorId: body.doctor_id, hospitalId: body.hospital_id, date: body.date, slotType: body.slot_type, requestedBy });
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// Get video link for an appointment (staff or patient)
router.get(
  '/link/:appointmentId',
  authenticate,
  validate(GetLinkSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { appointmentId } = req.params as { appointmentId: string };
    const requesterId = (req as any).user.sub as string;
    const result = await TeleconsultService.getVideoLink(appointmentId, requesterId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
