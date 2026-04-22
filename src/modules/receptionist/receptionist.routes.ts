import { Router, Request, Response } from 'express';
import * as ReceptionistService       from './receptionist.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload, UserRole } from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';
import { CollectionMode }             from '../../models';
import { Gender }                     from '../../models';

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const STAFF = [UserRole.RECEPTIONIST, UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN];

// ── Validation ────────────────────────────────────────────────────────────────
const ApptIdSchema    = z.object({ params: z.object({ appointmentId: z.string().uuid() }) });
const DoctorIdSchema  = z.object({ params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }) });

const DelaySchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  body:   z.object({ delay_minutes: z.number().int().min(1).max(480), reason: z.string().max(300).optional() }),
});

const AbsentSchema = z.object({
  params: z.object({ doctorId: z.string().uuid(), hospitalId: z.string().uuid() }),
  body:   z.object({ reason: z.string().max(300).optional() }),
});

const WalkInSchema = z.object({
  body: z.object({
    doctor_id:      z.string().uuid(),
    hospital_id:    z.string().uuid(),
    patient_mobile: z.string().regex(/^[6-9]\d{9}$/),
  }),
});

const QuickRegisterSchema = z.object({
  body: z.object({
    mobile:     z.string().regex(/^[6-9]\d{9}$/),
    full_name:  z.string().min(2).max(100),
    age:        z.number().int().min(0).max(130).optional(),
    gender:     z.nativeEnum(Gender).optional(),
    hospital_id: z.string().uuid(),
  }),
});

const StartVisitSchema = z.object({
  params: z.object({ patientId: z.string().uuid() }),
  body:   z.object({
    hospital_id: z.string().uuid(),
    doctor_id:   z.string().uuid(),
    patient_name: z.string().optional(),
  }),
});

const CollectPaymentSchema = z.object({
  body: z.object({
    hospital_id:     z.string().uuid(),
    patient_id:      z.string().uuid().optional(),
    amount:          z.number().positive(),
    mode:            z.nativeEnum(CollectionMode),
    appointment_id:  z.string().uuid().optional(),
    opd_token_id:    z.string().uuid().optional(),
    notes:           z.string().max(200).optional(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function markArrived(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await ReceptionistService.markPatientArrived(
    param(req, 'appointmentId'),
    user.hospital_id ?? '',
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function callNext(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await ReceptionistService.callNextPatient(
    param(req, 'doctorId'),
    user.hospital_id ?? '',
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function startConsultation(req: Request, res: Response): Promise<void> {
  const result = await ReceptionistService.startConsultation(param(req, 'appointmentId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function skipPatient(req: Request, res: Response): Promise<void> {
  const { reason } = req.body as { reason?: string };
  const result = await ReceptionistService.skipPatient(param(req, 'appointmentId'), reason);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function doctorCheckIn(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await ReceptionistService.doctorCheckIn(
    param(req, 'doctorId'), user.hospital_id ?? '', user.sub,
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function reportDelay(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const { delay_minutes, reason } = req.body as { delay_minutes: number; reason?: string };
  const result = await ReceptionistService.reportDoctorDelay(
    param(req, 'doctorId'), user.hospital_id ?? '', delay_minutes, reason, user.sub,
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function markAbsent(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const { reason } = req.body as { reason?: string };
  const result = await ReceptionistService.markDoctorAbsent(
    param(req, 'doctorId'), user.hospital_id ?? '', reason, user.sub,
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function bookWalkIn(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const body   = req.body as { doctor_id: string; hospital_id: string; patient_mobile: string };
  const result = await ReceptionistService.bookWalkIn({ ...body, receptionist_id: user.sub });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function lookupPatient(req: Request, res: Response): Promise<void> {
  const { q, hospital_id } = req.query as { q?: string; hospital_id?: string };
  if (!q || !hospital_id) { sendError(res, 400, { code: 'MISSING_PARAMS', message: 'q and hospital_id are required.' }); return; }
  const result = await ReceptionistService.patientLookup(q, hospital_id);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function registerPatient(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const body = req.body as { mobile: string; full_name: string; age?: number; gender?: Gender; hospital_id: string };
  const result = await ReceptionistService.quickRegister({ ...body, registered_by: user.sub });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function startVisitHandler(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const patient_id = param(req, 'patientId');
  const { hospital_id, doctor_id, patient_name } = req.body as { hospital_id: string; doctor_id: string; patient_name?: string };
  const result = await ReceptionistService.startVisit({ patient_id, hospital_id, doctor_id, created_by: user.sub, patient_name });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function collectPaymentHandler(req: Request, res: Response): Promise<void> {
  const user = req.user as JwtAccessPayload;
  const body = req.body as {
    hospital_id: string; patient_id?: string; amount: number; mode: CollectionMode;
    appointment_id?: string; opd_token_id?: string; notes?: string;
  };
  const result = await ReceptionistService.collectPayment({ ...body, collected_by: user.sub });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function getCollectionsHandler(req: Request, res: Response): Promise<void> {
  const { hospital_id, date, doctor_id } = req.query as { hospital_id?: string; date?: string; doctor_id?: string };
  if (!hospital_id || !date) { sendError(res, 400, { code: 'MISSING_PARAMS', message: 'hospital_id and date are required.' }); return; }
  const result = await ReceptionistService.getCollections(hospital_id, date, doctor_id);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();
router.use(authenticate, requireRole(...STAFF));

// Queue management
router.patch('/appointments/:appointmentId/arrived',       validate(ApptIdSchema),   asyncHandler(markArrived));
router.patch('/appointments/:appointmentId/start',         validate(ApptIdSchema),   asyncHandler(startConsultation));
router.patch('/appointments/:appointmentId/skip',          validate(ApptIdSchema),   asyncHandler(skipPatient));
router.post ('/doctors/:doctorId/:hospitalId/call-next',   validate(DoctorIdSchema), asyncHandler(callNext));

// Doctor attendance
router.post  ('/doctors/:doctorId/:hospitalId/check-in',   validate(DoctorIdSchema), asyncHandler(doctorCheckIn));
router.post  ('/doctors/:doctorId/:hospitalId/delay',      validate(DelaySchema),    asyncHandler(reportDelay));
router.post  ('/doctors/:doctorId/:hospitalId/absent',     validate(AbsentSchema),   asyncHandler(markAbsent));

// Walk-in booking
router.post('/walk-in', validate(WalkInSchema), asyncHandler(bookWalkIn));

// Patient Lookup
router.get ('/patients/lookup',                                              asyncHandler(lookupPatient));
router.post('/patients/quick-register', validate(QuickRegisterSchema),       asyncHandler(registerPatient));
router.post('/patients/:patientId/start-visit', validate(StartVisitSchema),  asyncHandler(startVisitHandler));
router.post('/collections',             validate(CollectPaymentSchema),       asyncHandler(collectPaymentHandler));
router.get ('/collections',                                                   asyncHandler(getCollectionsHandler));

export default router;
