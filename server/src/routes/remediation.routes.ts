import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth';
import { requireTenantCapability } from '../middleware/rbac';
import { AppError } from '../middleware/errorHandler';
import { isGodView } from '../utils/tenantScope';
import { db } from '../db';
import {
  listActions,
  createAction,
  updateAction,
  deleteAction,
  getBindings,
  getResolved,
  addBinding,
  updateBinding,
  deleteBinding,
  getRuns,
  getCapabilities,
  fetchSshFingerprint,
} from '../controllers/remediation.controller';

const router = Router();

router.use(requireAuth);

/** Tenant capability 'remediation' (platform admins and tenant admins always pass) */
const canManage = requireTenantCapability('remediation');

/**
 * By-id binding routes: the binding must belong to the active tenant (through
 * its action) — God View may reach any tenant. remediation_bindings has no
 * tenant_id of its own. 404 otherwise, so foreign ids are not disclosed.
 */
async function requireOwnedBinding(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0) return next(new AppError(400, 'Invalid binding ID'));
    const row = await db('remediation_bindings as b')
      .join('remediation_actions as a', 'a.id', 'b.action_id')
      .where('b.id', id)
      .first('a.tenant_id') as { tenant_id: number } | undefined;
    if (!row || (!isGodView(req) && row.tenant_id !== req.tenantId)) {
      return next(new AppError(404, 'Binding not found'));
    }
    next();
  } catch (err) {
    next(err);
  }
}

// ── Actions (capability 'remediation') ────────────────────────────────────────
// Actions are tenant-owned; the controller keeps them inside the active tenant.
router.get('/actions',        canManage, listActions);
router.post('/actions',       canManage, createAction);
router.put('/actions/:id',    canManage, updateAction);
router.delete('/actions/:id', canManage, deleteAction);

// ── Server-executed actions (script / ssh / docker_restart) ───────────────────
// Whether they may run here (REMEDIATION_ALLOW_SERVER_SCRIPTS) and whether the
// caller may manage them (platform admin on the master tenant, checked in the
// controller).
router.get('/capabilities', canManage, getCapabilities);
// Fetch an SSH host-key fingerprint to pin (same gate as creating an SSH action)
router.post('/ssh/fingerprint', canManage, fetchSshFingerprint);

// ── Bindings (capability 'remediation' to write) ──────────────────────────────
// Reads are tenant-scoped and permission-checked in the controller: the target
// must belong to the active tenant and be readable by the user, and actions are
// only returned as config-free summaries.
router.get('/bindings',       getBindings);
router.get('/resolved',       getResolved);
router.post('/bindings',      canManage, addBinding);
router.patch('/bindings/:id', canManage, requireOwnedBinding, updateBinding);
router.delete('/bindings/:id', canManage, requireOwnedBinding, deleteBinding);

// ── Run history ───────────────────────────────────────────────────────────────
// ?monitorId: readable monitors of the active tenant (output/error admin-only);
// ?actionId: admin only (checked in the controller).
router.get('/runs', getRuns);

export default router;
