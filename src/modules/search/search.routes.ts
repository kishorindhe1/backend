import { Router, Request, Response } from 'express';
import * as SearchService             from './search.service';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { sendSuccess, sendCreated, sendError } from '../../utils/response';
import { UserRole }                   from '../../types';
import { asyncHandler }               from '../../utils/asyncHandler';
import { z }                          from 'zod';
import { validate }                   from '../../middlewares/validate.middleware';

const qs = (req: Request, k: string, d = '') => String((req.query as Record<string,string>)[k] ?? d);
const qn = (req: Request, k: string) => {
  const v = (req.query as Record<string,string>)[k];
  return v ? parseFloat(v) : undefined;
};
const qb = (req: Request, k: string) => (req.query as Record<string,string>)[k] === 'true';

// ── Validation ────────────────────────────────────────────────────────────────
const AutocompleteSchema = z.object({
  query: z.object({
    q:    z.string().min(2, 'Query must be at least 2 characters'),
    city: z.string().optional(),
  }),
});

const SearchSchema = z.object({
  query: z.object({
    q:               z.string().optional(),
    specialization:  z.string().optional(),
    city:            z.string().optional(),
    date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    gender:          z.enum(['male','female','other']).optional(),
    language:        z.string().optional(),
    min_rating:      z.string().transform(Number).optional(),
    max_fee:         z.string().transform(Number).optional(),
    min_experience:  z.string().transform(Number).optional(),
    available_today: z.string().optional(),
    hospital_id:     z.string().uuid().optional(),
    lat:             z.string().transform(Number).optional(),
    lng:             z.string().transform(Number).optional(),
    sort:            z.enum(['relevance','distance','rating','fee_asc','fee_desc','availability','reliability']).optional(),
    page:            z.string().default('1').transform(Number),
    per_page:        z.string().default('20').transform(Number),
  }),
});

const RebuildSchema = z.object({
  body: z.object({
    doctor_id:   z.string().uuid().optional(),
    hospital_id: z.string().uuid().optional(),
  }),
});

// ── Controllers ───────────────────────────────────────────────────────────────
async function autocomplete(req: Request, res: Response): Promise<void> {
  const result = await SearchService.autocomplete(
    qs(req, 'q'),
    qs(req, 'city') || undefined,
  );
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}

async function searchDoctors(req: Request, res: Response): Promise<void> {
  const result = await SearchService.searchDoctors({
    q:               qs(req, 'q')              || undefined,
    specialization:  qs(req, 'specialization') || undefined,
    city:            qs(req, 'city')           || undefined,
    date:            qs(req, 'date')           || undefined,
    gender:          qs(req, 'gender')         || undefined,
    language:        qs(req, 'language')       || undefined,
    min_rating:      qn(req, 'min_rating'),
    max_fee:         qn(req, 'max_fee'),
    min_experience:  qn(req, 'min_experience'),
    available_today: qb(req, 'available_today'),
    hospital_id:     qs(req, 'hospital_id')    || undefined,
    lat:             qn(req, 'lat'),
    lng:             qn(req, 'lng'),
    sort:            (qs(req, 'sort') || 'relevance') as SearchService.SearchFilters['sort'],
    page:            parseInt(qs(req, 'page', '1'), 10),
    per_page:        Math.min(50, parseInt(qs(req, 'per_page', '20'), 10)),
  });
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  const d = result.data as { results: object[]; total: number; query_interpretation: object };
  sendSuccess(res, d.results, 200, {
    total: d.total,
    page:  parseInt(qs(req, 'page', '1'), 10),
    per_page: Math.min(50, parseInt(qs(req, 'per_page', '20'), 10)),
    total_pages: Math.ceil(d.total / Math.min(50, parseInt(qs(req, 'per_page', '20'), 10))),
  });
}

async function rebuildIndex(req: Request, res: Response): Promise<void> {
  const { doctor_id, hospital_id } = req.body as { doctor_id?: string; hospital_id?: string };
  if (doctor_id && hospital_id) {
    await SearchService.rebuildDoctorIndex(doctor_id, hospital_id);
    sendSuccess(res, { message: 'Index rebuilt for doctor.' });
  } else {
    const result = await SearchService.rebuildFullIndex();
    sendCreated(res, result);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
const router = Router();

// Public
router.get('/autocomplete', validate(AutocompleteSchema), asyncHandler(autocomplete));
router.get('/doctors',      validate(SearchSchema),       asyncHandler(searchDoctors));

// Admin only — trigger index rebuild
router.post('/rebuild',
  authenticate,
  requireRole(UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN),
  validate(RebuildSchema),
  asyncHandler(rebuildIndex),
);

export default router;
