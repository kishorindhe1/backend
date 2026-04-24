import multer, { FileFilterCallback } from 'multer';
import path from 'path';
import fs from 'fs';
import { Request } from 'express';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';
import { env } from '../config/env';

// ── Cloudinary config ─────────────────────────────────────────────────────────

const cloudinaryEnabled =
  !!env.CLOUDINARY_CLOUD_NAME && !!env.CLOUDINARY_API_KEY && !!env.CLOUDINARY_API_SECRET;

if (cloudinaryEnabled) {
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key:    env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
  });
}

function requireCloudinary(name: string): CloudinaryStorage {
  if (!cloudinaryEnabled) {
    throw new Error(`Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET to use ${name} uploads.`);
  }
  return new CloudinaryStorage({
    cloudinary,
    params: async (_req, _file) => ({}) as Record<string, unknown>,
  });
}

// ── Image file filter ─────────────────────────────────────────────────────────

function imageFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only JPEG, PNG and WebP images are allowed.'));
}

// ── Doctor profile photo ──────────────────────────────────────────────────────

const doctorPhotoStorage = cloudinaryEnabled
  ? new CloudinaryStorage({
      cloudinary,
      params: async () => ({
        folder:         'upcharify/doctors',
        format:         'webp',
        transformation: [{ width: 400, height: 400, crop: 'fill', gravity: 'face', quality: 'auto' }],
      }) as Record<string, unknown>,
    })
  : (() => { throw new Error('Cloudinary not configured'); })();

export const uploadDoctorPhoto = cloudinaryEnabled
  ? multer({ storage: doctorPhotoStorage, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single('photo')
  : multer().single('photo');

// ── Hospital logo ─────────────────────────────────────────────────────────────

const hospitalLogoStorage = cloudinaryEnabled
  ? new CloudinaryStorage({
      cloudinary,
      params: async () => ({
        folder:         'upcharify/hospitals',
        format:         'webp',
        transformation: [{ width: 600, height: 400, crop: 'fill', quality: 'auto' }],
      }) as Record<string, unknown>,
    })
  : (() => { throw new Error('Cloudinary not configured'); })();

export const uploadHospitalLogo = cloudinaryEnabled
  ? multer({ storage: hospitalLogoStorage, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single('logo')
  : multer().single('logo');

// ── Patient profile photo ─────────────────────────────────────────────────────

const patientPhotoStorage = cloudinaryEnabled
  ? new CloudinaryStorage({
      cloudinary,
      params: async () => ({
        folder:         'upcharify/patients',
        format:         'webp',
        transformation: [{ width: 300, height: 300, crop: 'fill', gravity: 'face', quality: 'auto' }],
      }) as Record<string, unknown>,
    })
  : (() => { throw new Error('Cloudinary not configured'); })();

export const uploadPatientPhoto = cloudinaryEnabled
  ? multer({ storage: patientPhotoStorage, fileFilter: imageFilter, limits: { fileSize: 5 * 1024 * 1024 } }).single('photo')
  : multer().single('photo');

// ── Health records (local disk — PDFs + images, private) ─────────────────────

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'health-records');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (_req, file, cb) => {
    const ext  = path.extname(file.originalname);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    cb(null, name);
  },
});

function recordFilter(_req: Request, file: Express.Multer.File, cb: FileFilterCallback) {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png', 'image/jpg'];
  if (allowed.includes(file.mimetype)) cb(null, true);
  else cb(new Error('Only PDF, JPEG and PNG files are allowed.'));
}

export const uploadHealthRecordFile = multer({
  storage:    diskStorage,
  fileFilter: recordFilter,
  limits:     { fileSize: 10 * 1024 * 1024 },
}).single('file');

export { cloudinaryEnabled };
