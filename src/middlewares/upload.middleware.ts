import multer, { FileFilterCallback } from 'multer';
import { Request } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { env } from '../config/env';

// ── Cloudinary config ─────────────────────────────────────────────────────────
// All file uploads go through Cloudinary — no local disk storage.
// This ensures multi-instance deploys share the same files and data
// is not lost on container restarts.

const cloudinaryEnabled =
  !!env.CLOUDINARY_CLOUD_NAME && !!env.CLOUDINARY_API_KEY && !!env.CLOUDINARY_API_SECRET;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME!,
    api_key:    env.CLOUDINARY_API_KEY!,
    api_secret: env.CLOUDINARY_API_SECRET!,
  });
}

function requireCloudinaryStorage(
  folder:  string,
  params?: Record<string, unknown>,
): CloudinaryStorage {
  if (!cloudinaryEnabled) {
    throw new Error(
      'Cloudinary credentials not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET.',
    );
  }
  return new CloudinaryStorage({
    cloudinary,
    params: async () => ({ folder, ...params }) as Record<string, unknown>,
  });
}

// ── File filters ──────────────────────────────────────────────────────────────

function imageFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (['image/jpeg', 'image/jpg', 'image/png', 'image/webp'].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPEG, PNG and WebP images are allowed.'));
}

function recordFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  if (['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'].includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only PDF, JPEG and PNG files are allowed for health records.'));
}

// ── Doctor profile photo ──────────────────────────────────────────────────────
export const uploadDoctorPhoto = multer({
  storage:    requireCloudinaryStorage('upcharify/doctors', {
    format:         'webp',
    transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }],
  }),
  fileFilter: imageFilter,
  limits:     { fileSize: 5 * 1024 * 1024 },
}).single('photo');

// ── Hospital logo ─────────────────────────────────────────────────────────────
export const uploadHospitalLogo = multer({
  storage:    requireCloudinaryStorage('upcharify/hospitals', {
    format:         'webp',
    transformation: [{ width: 600, height: 400, crop: 'fill', quality: 'auto' }],
  }),
  fileFilter: imageFilter,
  limits:     { fileSize: 5 * 1024 * 1024 },
}).single('logo');

// ── Patient profile photo ─────────────────────────────────────────────────────
export const uploadPatientPhoto = multer({
  storage:    requireCloudinaryStorage('upcharify/patients', {
    format:         'webp',
    transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face', quality: 'auto' }],
  }),
  fileFilter: imageFilter,
  limits:     { fileSize: 5 * 1024 * 1024 },
}).single('photo');

// ── Banner image ──────────────────────────────────────────────────────────────
export const uploadBannerImage = multer({
  storage:    requireCloudinaryStorage('upcharify/banners', { format: 'webp', quality: 'auto' }),
  fileFilter: imageFilter,
  limits:     { fileSize: 8 * 1024 * 1024 },
}).single('image');

// ── Health records — stored in Cloudinary private folder ─────────────────────
// Previously stored on local disk; now on Cloudinary so files survive redeploys
// and are accessible from any instance.
export const uploadHealthRecordFile = multer({
  storage:    requireCloudinaryStorage('upcharify/health-records', {
    resource_type: 'auto',  // allows PDFs
    type:          'private', // not publicly accessible by URL
    access_mode:   'authenticated',
  }),
  fileFilter: recordFilter,
  limits:     { fileSize: 10 * 1024 * 1024 },
}).single('file');

export { cloudinaryEnabled };
