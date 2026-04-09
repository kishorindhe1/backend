import { Router, Request, Response } from 'express';
import path from 'path';
import * as PatientController from './patient.controller';
import * as PatientService    from './patient.service';
import { authenticate } from '../../middlewares/auth.middleware';
import { validate } from '../../middlewares/validate.middleware';
import { requireCompleteProfile } from '../../middlewares/profileGuard.middleware';
import { uploadHealthRecordFile } from '../../middlewares/upload.middleware';
import {
  CompleteProfileSchema,
  UpdateProfileSchema,
} from './patient.validation';
import { asyncHandler } from '../../utils/asyncHandler';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload } from '../../types';
import { RecordType, Appointment, DoctorReview } from '../../models';
import { env } from '../../config/env';
import { z } from 'zod';

const router = Router();

// All patient routes require authentication
router.use(authenticate);

/**
 * @route   GET /api/v1/patients/me
 * @desc    Get own profile + completeness status
 * @access  Private
 */
router.get('/me', asyncHandler(PatientController.getMyProfile));

router.get('/me/stats', asyncHandler(async (req: Request, res: Response) => {
  const user = req.user as JwtAccessPayload;
  const [totalAppointments, uniqueDoctors, totalReviews] = await Promise.all([
    Appointment.count({ where: { patient_id: user.sub } }),
    Appointment.count({ where: { patient_id: user.sub }, distinct: true, col: 'doctor_id' } as any),
    DoctorReview.count({ where: { patient_id: user.sub } }),
  ]);
  sendSuccess(res, { total_appointments: totalAppointments, unique_doctors: uniqueDoctors, total_reviews: totalReviews });
}));

/**
 * @route   POST /api/v1/patients/me/complete-profile
 * @desc    Fill required fields for first-time users
 * @access  Private — allowed even with incomplete profile
 */
router.post(
  '/me/complete-profile',
  validate(CompleteProfileSchema),
  asyncHandler(PatientController.completeProfile),
);

/**
 * @route   PUT /api/v1/patients/me
 * @desc    Update profile (partial update)
 * @access  Private
 */
router.put(
  '/me',
  requireCompleteProfile,       // already-complete users updating their profile
  validate(UpdateProfileSchema),
  asyncHandler(PatientController.updateProfile),
);

// ── Health Records ────────────────────────────────────────────────────────────
const CreateRecordSchema = z.object({
  body: z.object({
    title:       z.string().trim().min(1).max(200),
    record_type: z.nativeEnum(RecordType),
    file_url:    z.string().url(),
    file_name:   z.string().max(255),
    file_size:   z.number().int().positive().optional(),
    mime_type:   z.string().max(100).optional(),
    notes:       z.string().max(1000).optional(),
    record_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
});

router.get(
  '/me/records',
  asyncHandler(async (req: Request, res: Response) => {
    const user    = req.user as JwtAccessPayload;
    const page       = parseInt(String((req.query as Record<string,string>).page     ?? '1'),  10);
    const perPage    = parseInt(String((req.query as Record<string,string>).per_page ?? '20'), 10);
    const recordType = String((req.query as Record<string,string>).type ?? '').trim() || undefined;
    const result  = await PatientService.getHealthRecords(user.sub, page, perPage, recordType);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    const d = result.data as { rows: object[]; count: number };
    sendSuccess(res, d.rows, 200, { total: d.count, page, per_page: perPage, total_pages: Math.ceil(d.count / perPage) });
  }),
);

// POST /me/records — accepts either multipart/form-data (with file) or JSON (with file_url)
router.post(
  '/me/records',
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const contentType = req.headers['content-type'] ?? '';

    if (contentType.includes('multipart/form-data')) {
      // Handle actual file upload
      await new Promise<void>((resolve, reject) =>
        uploadHealthRecordFile(req, res, (err: unknown) => (err ? reject(err) : resolve())),
      );

      const file = (req as any).file as Express.Multer.File | undefined;
      if (!file) { sendError(res, 400, { code: 'FILE_REQUIRED', message: 'No file uploaded.' }); return; }

      const body   = req.body as Record<string, string>;
      const name   = (body.name ?? body.title ?? '').trim();
      const rtype  = body.record_type as RecordType;

      if (!name)  { sendError(res, 400, { code: 'TITLE_REQUIRED', message: 'Record name is required.' }); return; }
      if (!rtype || !Object.values(RecordType).includes(rtype)) {
        sendError(res, 400, { code: 'INVALID_RECORD_TYPE', message: 'Invalid record_type.' }); return;
      }

      const baseUrl  = `${req.protocol}://${req.get('host')}`;
      const fileUrl  = `${baseUrl}/uploads/health-records/${file.filename}`;

      const result = await PatientService.createHealthRecord(user.sub, {
        title:       name,
        record_type: rtype,
        file_url:    fileUrl,
        file_name:   file.originalname,
        file_size:   file.size,
        mime_type:   file.mimetype,
        notes:       body.notes ?? null,
        record_date: body.record_date ?? undefined,
      });
      if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
      sendCreated(res, result.data);
    } else {
      // JSON path — expects file_url already provided (e.g. from S3)
      const parseResult = CreateRecordSchema.safeParse({ body: req.body });
      if (!parseResult.success) {
        sendError(res, 400, { code: 'VALIDATION_ERROR', message: parseResult.error.errors[0]?.message ?? 'Validation failed.' });
        return;
      }
      const result = await PatientService.createHealthRecord(user.sub, req.body);
      if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
      sendCreated(res, result.data);
    }
  }),
);

router.get(
  '/me/records/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const user     = req.user as JwtAccessPayload;
    const recordId = (req.params as Record<string,string>).recordId;
    const result   = await PatientService.getHealthRecord(user.sub, recordId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

router.delete(
  '/me/records/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const user     = req.user as JwtAccessPayload;
    const recordId = (req.params as Record<string,string>).recordId;
    const result   = await PatientService.deleteHealthRecord(user.sub, recordId);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

export default router;
