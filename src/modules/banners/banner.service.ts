import { Op } from 'sequelize';
import { Banner, BannerLinkType } from '../../models/banner.model';

type ServiceResult<T = unknown> =
  | { success: true;  data: T }
  | { success: false; statusCode: number; code: string; message: string };

export interface BannerCreatePayload {
  title?:         string;
  subtitle?:      string;
  image_url:      string;
  link_type?:     BannerLinkType;
  link_value?:    string;
  cta_label?:     string;
  is_active?:     boolean;
  display_order?: number;
  starts_at?:     string;
  ends_at?:       string;
}

export interface BannerUpdatePayload extends Partial<BannerCreatePayload> {}

// ── Public: active banners within current date window ────────────────────────

export async function getActiveBanners(): Promise<ServiceResult<Banner[]>> {
  const now = new Date();
  const banners = await Banner.findAll({
    where: {
      is_active: true,
      [Op.and]: [
        { [Op.or]: [{ starts_at: null }, { starts_at: { [Op.lte]: now } }] },
        { [Op.or]: [{ ends_at:   null }, { ends_at:   { [Op.gte]: now } }] },
      ],
    },
    order: [['display_order', 'ASC'], ['created_at', 'DESC']],
  });
  return { success: true, data: banners };
}

// ── Admin: list all banners ───────────────────────────────────────────────────

export async function listAllBanners(): Promise<ServiceResult<Banner[]>> {
  const banners = await Banner.findAll({
    order: [['display_order', 'ASC'], ['created_at', 'DESC']],
  });
  return { success: true, data: banners };
}

// ── Admin: create ─────────────────────────────────────────────────────────────

export async function createBanner(
  payload: BannerCreatePayload,
  createdBy: string,
): Promise<ServiceResult<Banner>> {
  const banner = await Banner.create({
    title:         payload.title         ?? null,
    subtitle:      payload.subtitle      ?? null,
    image_url:     payload.image_url,
    link_type:     payload.link_type     ?? BannerLinkType.NONE,
    link_value:    payload.link_value    ?? null,
    cta_label:     payload.cta_label     ?? null,
    is_active:     payload.is_active     ?? false,
    display_order: payload.display_order ?? 0,
    starts_at:     payload.starts_at ? new Date(payload.starts_at) : null,
    ends_at:       payload.ends_at   ? new Date(payload.ends_at)   : null,
    created_by:    createdBy,
  });
  return { success: true, data: banner };
}

// ── Admin: update ─────────────────────────────────────────────────────────────

export async function updateBanner(
  id: string,
  payload: BannerUpdatePayload,
): Promise<ServiceResult<Banner>> {
  const banner = await Banner.findByPk(id);
  if (!banner) return { success: false, statusCode: 404, code: 'BANNER_NOT_FOUND', message: 'Banner not found.' };

  await banner.update({
    ...(payload.title         !== undefined && { title:         payload.title }),
    ...(payload.subtitle      !== undefined && { subtitle:      payload.subtitle }),
    ...(payload.image_url     !== undefined && { image_url:     payload.image_url }),
    ...(payload.link_type     !== undefined && { link_type:     payload.link_type }),
    ...(payload.link_value    !== undefined && { link_value:    payload.link_value }),
    ...(payload.cta_label     !== undefined && { cta_label:     payload.cta_label }),
    ...(payload.is_active     !== undefined && { is_active:     payload.is_active }),
    ...(payload.display_order !== undefined && { display_order: payload.display_order }),
    ...(payload.starts_at     !== undefined && { starts_at:     payload.starts_at ? new Date(payload.starts_at) : null }),
    ...(payload.ends_at       !== undefined && { ends_at:       payload.ends_at   ? new Date(payload.ends_at)   : null }),
  });
  return { success: true, data: banner };
}

// ── Admin: update image URL after Cloudinary upload ───────────────────────────

export async function updateBannerImage(
  id: string,
  image_url: string,
): Promise<ServiceResult<Banner>> {
  const banner = await Banner.findByPk(id);
  if (!banner) return { success: false, statusCode: 404, code: 'BANNER_NOT_FOUND', message: 'Banner not found.' };
  await banner.update({ image_url });
  return { success: true, data: banner };
}

// ── Admin: delete ─────────────────────────────────────────────────────────────

export async function deleteBanner(id: string): Promise<ServiceResult<void>> {
  const banner = await Banner.findByPk(id);
  if (!banner) return { success: false, statusCode: 404, code: 'BANNER_NOT_FOUND', message: 'Banner not found.' };
  await banner.destroy();
  return { success: true, data: undefined };
}
