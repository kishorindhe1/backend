import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken } from '../modules/auth/token.service';
import { sendUnauthorized, sendForbidden } from '../utils/response';
import { UserRole, AccountStatus, JwtAccessPayload } from '../types';

/**
 * Verifies the Bearer token in the Authorization header.
 * Attaches the decoded payload to req.user.
 * Rejects suspended accounts.
 */
export async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    sendUnauthorized(res, 'AUTH_TOKEN_MISSING', 'Authorization header is required.');
    return;
  }

  const token   = authHeader.slice(7);
  const payload = await verifyAccessToken(token);

  if (!payload) {
    sendUnauthorized(res, 'AUTH_TOKEN_INVALID', 'Token is invalid or has expired.');
    return;
  }

  if (payload.account_status === AccountStatus.SUSPENDED) {
    sendForbidden(res, 'AUTH_ACCOUNT_SUSPENDED', 'Your account has been suspended. Please contact support.');
    return;
  }

  req.user = payload;
  next();
}

/**
 * Role-based access control.
 * Call AFTER authenticate.
 *
 * Usage:
 *   router.get('/admin/...', authenticate, requireRole(UserRole.SUPER_ADMIN), handler)
 */
export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user as JwtAccessPayload;

    if (!roles.includes(user.role)) {
      sendForbidden(
        res,
        'AUTH_INSUFFICIENT_PERMISSIONS',
        `This action requires one of the following roles: ${roles.join(', ')}.`,
      );
      return;
    }

    next();
  };
}

/**
 * Optional authentication — attaches req.user if token is present and valid,
 * but does NOT reject the request if no token is provided.
 * Used for public routes that show richer data to authenticated users.
 */
export async function optionalAuthenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (authHeader?.startsWith('Bearer ')) {
    const token   = authHeader.slice(7);
    const payload = await verifyAccessToken(token);
    if (payload) req.user = payload;
  }

  next();
}
