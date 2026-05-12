import { Router, Request, Response } from 'express';
import { z }                          from 'zod';
import { authenticate, requireRole }  from '../../middlewares/auth.middleware';
import { validate }                   from '../../middlewares/validate.middleware';
import { uploadBannerImage }          from '../../middlewares/upload.middleware';
import { sendSuccess, sendError }     from '../../utils/response';
import { asyncHandler }               from '../../utils/asyncHandler';
import { UserRole, JwtAccessPayload } from '../../types';
import * as BannerService             from './banner.service';
import { BannerLinkType }             from '../../models/banner.model';

const router = Router();

// ── Public: fetch active banners (app home screen) ────────────────────────────

router.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const result = await BannerService.getActiveBanners();
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

// ── Admin-only below this line ────────────────────────────────────────────────

const adminRouter = Router();
adminRouter.use(authenticate, requireRole(UserRole.SUPER_ADMIN, UserRole.HOSPITAL_ADMIN));

// Validation schemas
const CreateBannerSchema = z.object({
  body: z.object({
    title:         z.string().max(120).optional(),
    subtitle:      z.string().max(200).optional(),
    image_url:     z.string().url().max(500),
    link_type:     z.nativeEnum(BannerLinkType).optional(),
    link_value:    z.string().max(500).optional(),
    cta_label:     z.string().max(60).optional(),
    is_active:     z.boolean().optional(),
    display_order: z.number().int().min(0).optional(),
    starts_at:     z.string().datetime().optional(),
    ends_at:       z.string().datetime().optional(),
  }),
});

const UpdateBannerSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    title:         z.string().max(120).optional(),
    subtitle:      z.string().max(200).optional(),
    image_url:     z.string().url().max(500).optional(),
    link_type:     z.nativeEnum(BannerLinkType).optional(),
    link_value:    z.string().max(500).nullable().optional(),
    cta_label:     z.string().max(60).nullable().optional(),
    is_active:     z.boolean().optional(),
    display_order: z.number().int().min(0).optional(),
    starts_at:     z.string().datetime().nullable().optional(),
    ends_at:       z.string().datetime().nullable().optional(),
  }),
});

const UuidParamSchema = z.object({
  params: z.object({ id: z.string().uuid() }),
});

// GET /admin/banners — list all
adminRouter.get('/', asyncHandler(async (_req: Request, res: Response) => {
  const result = await BannerService.listAllBanners();
  if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
  sendSuccess(res, result.data);
}));

// POST /admin/banners — create (image_url required in body initially)
adminRouter.post('/',
  validate(CreateBannerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const user = req.user as JwtAccessPayload;
    const result = await BannerService.createBanner(req.body, user.sub);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    res.status(201).json({ success: true, data: result.data });
  }),
);

// PATCH /admin/banners/:id/image — upload image via Cloudinary
adminRouter.patch('/:id/image',
  validate(UuidParamSchema),
  uploadBannerImage,
  asyncHandler(async (req: Request, res: Response) => {
    const file = req.file as (Express.Multer.File & { path?: string }) | undefined;
    if (!file) { sendError(res, 400, { code: 'BANNER_NO_IMAGE', message: 'Image file is required.' }); return; }
    const image_url = (file as any).path ?? (file as any).secure_url ?? '';
    if (!image_url) { sendError(res, 400, { code: 'BANNER_UPLOAD_FAILED', message: 'Image upload failed.' }); return; }
    const result = await BannerService.updateBannerImage(req.params.id, image_url);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// PUT /admin/banners/:id — update metadata
adminRouter.put('/:id',
  validate(UpdateBannerSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await BannerService.updateBanner(req.params.id, req.body);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, result.data);
  }),
);

// DELETE /admin/banners/:id — super admin only
adminRouter.delete('/:id',
  requireRole(UserRole.SUPER_ADMIN),
  validate(UuidParamSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await BannerService.deleteBanner(req.params.id);
    if (!result.success) { sendError(res, result.statusCode, { code: result.code, message: result.message }); return; }
    sendSuccess(res, { message: 'Banner deleted.' });
  }),
);

export { adminRouter as bannerAdminRouter };
export default router;
