import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { env } from '../config/env';

// ── OTP ───────────────────────────────────────────────────────────────────────
export function generateOTP(): string {
  // Cryptographically secure 6-digit OTP
  const buffer = crypto.randomBytes(3);
  const num = buffer.readUIntBE(0, 3) % 1000000;
  return num.toString().padStart(6, '0');
}

export async function hashOTP(otp: string): Promise<string> {
  return bcrypt.hash(otp, 10); // lighter rounds for OTP (short-lived)
}

export async function verifyOTP(otp: string, hash: string): Promise<boolean> {
  return bcrypt.compare(otp, hash);
}

// ── Password ──────────────────────────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── Phone number ──────────────────────────────────────────────────────────────
export function normalizeMobile(mobile: string, countryCode = '+91'): string {
  // Strip all non-digits
  const digits = mobile.replace(/\D/g, '');
  // Remove leading country code digits if present
  const stripped = digits.startsWith('91') && digits.length === 12
    ? digits.slice(2)
    : digits;
  return stripped;
}

export function maskMobile(mobile: string): string {
  if (mobile.length < 6) return mobile;
  return `${mobile.slice(0, 2)}${'*'.repeat(mobile.length - 4)}${mobile.slice(-2)}`;
}

export function isValidIndianMobile(mobile: string): boolean {
  const digits = normalizeMobile(mobile);
  // Indian mobile: 10 digits starting with 6-9
  return /^[6-9]\d{9}$/.test(digits);
}

// ── Date helpers ──────────────────────────────────────────────────────────────
export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function isExpired(date: Date): boolean {
  return date < new Date();
}

// ── Pagination ────────────────────────────────────────────────────────────────
export function getPaginationParams(
  query: Record<string, unknown>,
  defaultPerPage = 20,
  maxPerPage = 50,
): { limit: number; offset: number; page: number } {
  const page = Math.max(1, parseInt(String(query.page ?? 1), 10));
  const perPage = Math.min(
    maxPerPage,
    Math.max(1, parseInt(String(query.per_page ?? defaultPerPage), 10)),
  );
  return {
    limit: perPage,
    offset: (page - 1) * perPage,
    page,
  };
}

// ── UUID ──────────────────────────────────────────────────────────────────────
export { v4 as generateUUID } from 'uuid';

// ── Patient profile helpers (moved from patient.model to avoid circular imports) ──
import type { PatientProfile } from '../models/patient.model';

export function getMissingFields(profile: PatientProfile): string[] {
  const missing: string[] = [];
  if (!profile.full_name)     missing.push('full_name');
  if (!profile.date_of_birth) missing.push('date_of_birth');
  if (!profile.gender)        missing.push('gender');
  return missing;
}

export function getCompletionPercentage(profile: PatientProfile): number {
  const all    = ['full_name', 'date_of_birth', 'gender', 'email', 'blood_group', 'profile_photo_url'];
  const filled = all.filter((f) => {
    const val = (profile as unknown as Record<string, unknown>)[f];
    return val !== null && val !== undefined && val !== '';
  }).length;
  return Math.round((filled / all.length) * 100);
}
