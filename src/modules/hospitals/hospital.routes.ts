import { Router, Request, Response } from 'express';
import * as HospitalService          from './hospital.service';
import { authenticate, requireRole } from '../../middlewares/auth.middleware';
import { validate }                  from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload, UserRole } from '../../types';
import { asyncHandler }              from '../../utils/asyncHandler';
import { z }                         from 'zod';
import { OnboardingStatus, AppointmentApprovalMode, PaymentCollectionMode } from '../../models';

// ── Safe extractors ───────────────────────────────────────────────────────────
const param = (req: Request, key: string): string =>
  String((req.params as Record<string, string>)[key] ?? '');

const qs = (req: Request, key: string, fallback: string): string =>
  String((req.query as Record<string, string>)[key] ?? fallback);

// ── Validation schemas ────────────────────────────────────────────────────────
const RegisterHospitalSchema = z.object({
  body: z.object({
    admin_mobile:  z.string().regex(/^[6-9]\d{9}$/),
    admin_name:    z.string().trim().min(2).max(100),
    hospital_name: z.string().trim().min(2).max(200),
    city:          z.string().trim().min(2).max(100),
    state:         z.string().trim().min(2).max(100),
    hospital_type: z.enum(['clinic','nursing_home','hospital','diagnostic_center']),
  }),
});

const AddReceptionistSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({
    mobile:     z.string().regex(/^[6-9]\d{9}$/),
    department: z.string().optional(),
  }),
});

const UpdateStatusSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body:   z.object({ status: z.nativeEnum(OnboardingStatus) }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function registerHospital(req: Request, res: Response): Promise<void> {
  const result = await HospitalService.registerHospital(
    req.body as HospitalService.RegisterHospitalInput,
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function getHospital(req: Request, res: Response): Promise<void> {
  const result = await HospitalService.getHospital(param(req, 'id'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function listHospitals(req: Request, res: Response): Promise<void> {
  const page    = parseInt(qs(req, 'page',     '1'),  10);
  const perPage = parseInt(qs(req, 'per_page', '20'), 10);
  const city    = qs(req, 'city', '') || undefined;
  const latRaw  = (req.query as Record<string, string>).lat;
  const lngRaw  = (req.query as Record<string, string>).lng;
  const lat     = latRaw  ? parseFloat(latRaw)  : undefined;
  const lng     = lngRaw  ? parseFloat(lngRaw)  : undefined;
  const result  = await HospitalService.listHospitals({ city, lat, lng, page, perPage });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { rows: object[]; count: number };
  sendSuccess(res, d.rows, 200, {
    total: d.count, page, per_page: perPage,
    total_pages: Math.ceil(d.count / perPage),
  });
}

async function updateOnboardingStatus(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const { status } = req.body as { status: OnboardingStatus };
  const result = await HospitalService.updateOnboardingStatus(param(req, 'id'), status, user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function addReceptionist(req: Request, res: Response): Promise<void> {
  const { mobile, department } = req.body as { mobile: string; department?: string };
  const result = await HospitalService.addReceptionist(param(req, 'id'), mobile, department);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

router.get('/',    asyncHandler(listHospitals));
router.get('/:id', asyncHandler(getHospital));

router.post('/',
  authenticate, requireRole(UserRole.SUPER_ADMIN),
  validate(RegisterHospitalSchema),
  asyncHandler(registerHospital),
);

router.patch('/:id/onboarding-status',
  authenticate, requireRole(UserRole.SUPER_ADMIN),
  validate(UpdateStatusSchema),
  asyncHandler(updateOnboardingStatus),
);

router.post('/:id/receptionists',
  authenticate, requireRole(UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN),
  validate(AddReceptionistSchema),
  asyncHandler(addReceptionist),
);

router.patch('/:id/payment-collection-mode',
  authenticate, requireRole(UserRole.HOSPITAL_ADMIN),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({ mode: z.nativeEnum(PaymentCollectionMode) }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { mode } = req.body as { mode: PaymentCollectionMode };
    const result = await HospitalService.updatePaymentCollectionMode(param(req, 'id'), mode, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.patch('/:id/appointment-approval',
  authenticate, requireRole(UserRole.HOSPITAL_ADMIN),
  validate(z.object({
    params: z.object({ id: z.string().uuid() }),
    body:   z.object({ mode: z.nativeEnum(AppointmentApprovalMode) }),
  })),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const { mode } = req.body as { mode: AppointmentApprovalMode };
    const result = await HospitalService.updateAppointmentApprovalMode(param(req, 'id'), mode, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
