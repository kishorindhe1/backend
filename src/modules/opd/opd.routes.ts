import { Router, Request, Response } from 'express';
import * as OpdService                from './opd.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { JwtAccessPayload, UserRole } from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';

const param = (req: Request, k: string) => String((req.params as Record<string,string>)[k] ?? '');
const STAFF = [UserRole.RECEPTIONIST, UserRole.HOSPITAL_ADMIN, UserRole.SUPER_ADMIN];

const CreateSessionSchema = z.object({
  body: z.object({
    doctor_id:          z.string().uuid(),
    hospital_id:        z.string().uuid(),
    session_date:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    session_type:       z.enum(['morning','evening','full_day']),
    start_time:         z.string().regex(/^\d{2}:\d{2}$/),
    expected_end_time:  z.string().regex(/^\d{2}:\d{2}$/),
    total_tokens:       z.number().int().min(1).max(500),
    online_token_limit: z.number().int().min(0),
    walkin_token_limit: z.number().int().min(0),
  }),
});

const WalkInTokenSchema = z.object({
  params: z.object({ sessionId: z.string().uuid() }),
  body:   z.object({ patient_mobile: z.string().regex(/^[6-9]\d{9}$/).optional() }),
});

const SessionIdSchema = z.object({ params: z.object({ sessionId: z.string().uuid() }) });

async function createSession(req: Request, res: Response): Promise<void> {
  const result = await OpdService.createSession(req.body as OpdService.CreateSessionInput);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function issueWalkInToken(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const { patient_mobile } = req.body as { patient_mobile?: string };
  // For walk-ins without a known patient, pass null
  const result = await OpdService.issueWalkInToken(param(req, 'sessionId'), patient_mobile ?? null, user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}

async function pauseSession(req: Request, res: Response): Promise<void> {
  const result = await OpdService.pauseSession(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function resumeSession(req: Request, res: Response): Promise<void> {
  const result = await OpdService.resumeSession(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function cancelSession(req: Request, res: Response): Promise<void> {
  const result = await OpdService.cancelSession(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function activateSession(req: Request, res: Response): Promise<void> {
  const user   = req.user as JwtAccessPayload;
  const result = await OpdService.activateSession(param(req, 'sessionId'), user.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function callNext(req: Request, res: Response): Promise<void> {
  const result = await OpdService.callNextToken(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getTokens(req: Request, res: Response): Promise<void> {
  const result = await OpdService.listTokens(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function getStats(req: Request, res: Response): Promise<void> {
  const result = await OpdService.getSessionStats(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function listSessions(req: Request, res: Response): Promise<void> {
  const { hospital_id, doctor_id, date } = req.query as { hospital_id?: string; doctor_id?: string; date?: string };
  if (!hospital_id) { sendError(res, 400, { code: 'MISSING_HOSPITAL', message: 'hospital_id query param is required.' }); return; }
  const result = await OpdService.listSessions(hospital_id, doctor_id, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

const router = Router();

// List sessions
router.get('/',                          authenticate, requireRole(...STAFF), asyncHandler(listSessions));

// Staff-only routes
router.post('/',                         authenticate, requireRole(...STAFF), validate(CreateSessionSchema), asyncHandler(createSession));
router.patch('/:sessionId/activate',     authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(activateSession));
router.patch('/:sessionId/pause',        authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(pauseSession));
router.patch('/:sessionId/resume',       authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(resumeSession));
router.patch('/:sessionId/cancel',       authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(cancelSession));
router.post ('/:sessionId/call-next',    authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(callNext));
router.post ('/:sessionId/walkin-token', authenticate, requireRole(...STAFF), validate(WalkInTokenSchema),   asyncHandler(issueWalkInToken));

// Token list + stats — staff + doctor
router.get  ('/:sessionId/tokens',       authenticate, requireRole(...STAFF), validate(SessionIdSchema), asyncHandler(getTokens));
router.get  ('/:sessionId/stats',        authenticate, validate(SessionIdSchema), asyncHandler(getStats));

export default router;
