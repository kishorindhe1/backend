import { Request, Response, NextFunction } from 'express';
import { sendForbidden }                  from '../utils/response';
import { JwtAccessPayload, UserRole }     from '../types';

// ── Permission registry ───────────────────────────────────────────────────────
export enum Permission {
  // Platform-wide monitoring (SUPER_ADMIN only)
  PLATFORM_READ        = 'platform:read',
  AUDIT_READ           = 'audit:read',

  // Hospitals
  HOSPITALS_READ       = 'hospitals:read',    // list / view
  HOSPITALS_MANAGE     = 'hospitals:manage',  // suspend / activate / status change

  // Doctors
  DOCTORS_READ         = 'doctors:read',
  DOCTORS_VERIFY       = 'doctors:verify',    // approve / reject verification
  DOCTORS_MANAGE       = 'doctors:manage',    // suspend / reactivate

  // Patients
  PATIENTS_READ        = 'patients:read',
  PATIENTS_MANAGE      = 'patients:manage',   // suspend / activate

  // Appointments
  APPOINTMENTS_READ    = 'appointments:read',
  APPOINTMENTS_MANAGE  = 'appointments:manage', // cancel from admin

  // Financials
  FINANCIALS_READ      = 'financials:read',

  // Staff
  STAFF_MANAGE         = 'staff:manage',
}

// ── Role → permission map ─────────────────────────────────────────────────────
const ROLE_PERMISSIONS: Partial<Record<UserRole, Permission[]>> = {
  [UserRole.SUPER_ADMIN]: Object.values(Permission),

  [UserRole.HOSPITAL_ADMIN]: [
    Permission.PLATFORM_READ,       // scoped dashboard & alerts
    Permission.HOSPITALS_READ,      // their own hospital
    Permission.DOCTORS_READ,        // doctors in their hospital
    Permission.APPOINTMENTS_READ,   // their appointments
    Permission.APPOINTMENTS_MANAGE,
    Permission.FINANCIALS_READ,     // their financials
    Permission.STAFF_MANAGE,        // their staff
  ],

  [UserRole.RECEPTIONIST]: [
    Permission.APPOINTMENTS_READ,
    Permission.APPOINTMENTS_MANAGE,
  ],
};

// ── Middleware ────────────────────────────────────────────────────────────────

/** Enforce a specific permission. Must run after authenticate(). */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user    = req.user as JwtAccessPayload;
    const allowed = ROLE_PERMISSIONS[user.role] ?? [];
    if (!allowed.includes(permission)) {
      sendForbidden(res, 'AUTH_INSUFFICIENT_PERMISSIONS', 'You do not have permission to perform this action.');
      return;
    }
    next();
  };
}

/**
 * Returns the hospital_id to scope queries to.
 * - HOSPITAL_ADMIN  → their hospital_id (from JWT)
 * - SUPER_ADMIN     → undefined (no scope, see all data)
 */
export function scopedHospitalId(req: Request): string | undefined {
  const user = req.user as JwtAccessPayload;
  return user.role === UserRole.HOSPITAL_ADMIN ? (user.hospital_id ?? undefined) : undefined;
}
