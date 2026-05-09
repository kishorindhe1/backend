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

const PauseSessionSchema = z.object({
  params: z.object({ sessionId: z.string().uuid() }),
  body:   z.object({ estimated_break_minutes: z.number().int().min(1).max(180).optional() }),
});

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
  const { estimated_break_minutes } = req.body as { estimated_break_minutes?: number };
  const result = await OpdService.pauseSession(param(req, 'sessionId'), estimated_break_minutes);
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

const GenerateSessionsSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid(),
    hospital_id: z.string().uuid(),
    date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const AvailableSessionsSchema = z.object({
  query: z.object({
    doctor_id:   z.string().uuid(),
    hospital_id: z.string().uuid(),
    date:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
});

const router = Router();

// Public — patient sees available queue sessions before booking
router.get('/available', validate(AvailableSessionsSchema), asyncHandler(async (req: Request, res: Response) => {
  const { doctor_id, hospital_id, date } = req.query as { doctor_id: string; hospital_id: string; date: string };
  const result = await OpdService.listAvailableSessions(doctor_id, hospital_id, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

// Admin — generate queue sessions for a date from schedule config
router.post('/generate', authenticate, requireRole(...STAFF), validate(GenerateSessionsSchema), asyncHandler(async (req: Request, res: Response) => {
  const { doctor_id, hospital_id, date } = req.body as { doctor_id: string; hospital_id: string; date: string };
  const result = await OpdService.generateSessionsFromSchedule(doctor_id, hospital_id, date);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}));

// List sessions
router.get('/',                          authenticate, requireRole(...STAFF), asyncHandler(listSessions));

// Staff-only routes
router.post('/',                         authenticate, requireRole(...STAFF), validate(CreateSessionSchema), asyncHandler(createSession));
router.patch('/:sessionId/activate',     authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(activateSession));
router.patch('/:sessionId/pause',        authenticate, requireRole(...STAFF), validate(PauseSessionSchema),  asyncHandler(pauseSession));
router.patch('/:sessionId/resume',       authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(resumeSession));
router.patch('/:sessionId/cancel',       authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(cancelSession));
router.post ('/:sessionId/call-next',    authenticate, requireRole(...STAFF), validate(SessionIdSchema),     asyncHandler(callNext));
router.post ('/:sessionId/walkin-token', authenticate, requireRole(...STAFF), validate(WalkInTokenSchema),   asyncHandler(issueWalkInToken));

// Breaks — staff only
const AddBreakSchema = z.object({ params: z.object({ sessionId: z.string().uuid() }), body: z.object({ start_time: z.string().regex(/^\d{2}:\d{2}$/), end_time: z.string().regex(/^\d{2}:\d{2}$/), reason: z.string().max(100).optional() }) });
const BreakIdSchema  = z.object({ params: z.object({ sessionId: z.string().uuid(), breakId: z.string().uuid() }) });

router.get   ('/:sessionId/breaks',           authenticate, requireRole(...STAFF), validate(SessionIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await OpdService.listBreaks(req.params.sessionId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));
router.post  ('/:sessionId/breaks',           authenticate, requireRole(...STAFF), validate(AddBreakSchema), asyncHandler(async (req: Request, res: Response) => {
  const { start_time, end_time, reason } = req.body as { start_time: string; end_time: string; reason?: string };
  const result = await OpdService.addBreak(req.params.sessionId, start_time, end_time, reason);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendCreated(res, result.data);
}));
router.delete('/:sessionId/breaks/:breakId',  authenticate, requireRole(...STAFF), validate(BreakIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await OpdService.removeBreak(req.params.sessionId, req.params.breakId);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

// Token list + stats — staff + doctor
router.get  ('/:sessionId/tokens',       authenticate, requireRole(...STAFF), validate(SessionIdSchema), asyncHandler(getTokens));
router.get  ('/:sessionId/stats',        authenticate, validate(SessionIdSchema), asyncHandler(getStats));

// Public session info — shown to patient before/after QR scan (no token required)
router.get  ('/:sessionId/public',       validate(SessionIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await OpdService.getSessionPublicInfo(param(req, 'sessionId'));
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

// Patient joins queue via QR scan — authenticated patient only
router.post ('/:sessionId/join',         authenticate, requireRole(UserRole.PATIENT), validate(SessionIdSchema), asyncHandler(async (req: Request, res: Response) => {
  const result = await OpdService.joinAsWalkin(param(req, 'sessionId'), req.user!.sub);
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

export default router;
