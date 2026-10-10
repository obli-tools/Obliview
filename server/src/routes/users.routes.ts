import { Router, type Request, type Response, type NextFunction } from 'express';
import { usersController } from '../controllers/users.controller';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin, requireTenantCapability } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { validate } from '../middleware/validate';
import { db } from '../db';
import { isMasterTenant } from '@obliview/shared';
import {
  createUserSchema,
  updateUserSchema,
  changePasswordSchema,
} from '../validators/user.schema';

const router = Router();

router.use(requireAuth);
// Tenant capability 'users.manage' (platform admins and tenant admins always pass)
router.use(requireTenantCapability('users.manage'));

/**
 * Guard rails for tenant-level user managers (non platform admins):
 *   - the target must be a member of the active workspace (404 otherwise);
 *   - platform admins can only be managed by platform admins (403);
 *   - the platform role (users.role) cannot be granted or changed (403).
 * Platform admins are not restricted here (the controller still applies its
 * own scope rules).
 */
function guardUserTarget(opts: { allowRoleField?: 'user-only' | 'never' } = {}) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.session.role === 'admin') return next();

      const body = (req.body ?? {}) as { role?: unknown };
      if (opts.allowRoleField === 'never' && body.role !== undefined) {
        return next(new AppError(403, 'Only a platform admin can change the platform role'));
      }
      if (opts.allowRoleField === 'user-only' && body.role !== undefined && body.role !== 'user') {
        return next(new AppError(403, 'Only a platform admin can create a platform admin'));
      }

      if (req.params.id === undefined) return next();
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) return next(new AppError(400, 'Invalid user ID'));
      const tenantId = req.tenantId;
      // Same membership rule as userService.getAll / userScope.isMemberOf:
      // accounts without any user_tenants row belong to the master tenant.
      const target = await db('users')
        .where('users.id', id)
        .where(function () {
          this.whereExists(
            db('user_tenants')
              .whereRaw('user_tenants.user_id = users.id')
              .where('user_tenants.tenant_id', tenantId),
          );
          if (isMasterTenant(tenantId)) {
            this.orWhereNotExists(db('user_tenants').whereRaw('user_tenants.user_id = users.id'));
          }
        })
        .first('users.role') as { role: string } | undefined;
      if (!target) return next(new AppError(404, 'User not found'));
      if (target.role === 'admin') {
        return next(new AppError(403, 'Only a platform admin can manage a platform admin'));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

router.get('/', usersController.list);
router.get('/:id', guardUserTarget(), usersController.getById);
router.post('/', validate(createUserSchema), guardUserTarget({ allowRoleField: 'user-only' }), usersController.create);
router.put('/:id', validate(updateUserSchema), guardUserTarget({ allowRoleField: 'never' }), usersController.update);
router.put('/:id/password', validate(changePasswordSchema), guardUserTarget(), usersController.changePassword);
router.delete('/:id', guardUserTarget(), usersController.delete);
// Admin reset of a locked-out user's second factors (not one's own, not SSO)
router.delete('/:id/2fa', guardUserTarget(), usersController.resetTwoFactor);

// Team membership listing
router.get('/:id/teams', guardUserTarget(), usersController.getTeams);

// Tenant assignment management — lists and changes every workspace: platform
// admins only (tenant-level managers cannot reassign workspaces)
router.get('/:id/tenants', requirePlatformAdmin(), usersController.getTenants);
router.put('/:id/tenants', requirePlatformAdmin(), usersController.setTenants);

export default router;
