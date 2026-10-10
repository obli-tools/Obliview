import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { isMasterTenant } from '@obliview/shared';
import { tenantService, resolveTenantRole } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import { clearGroupStatsCache } from '../controllers/groups.controller';
import { permissionService } from '../services/permission.service';
import { AGENTS_MANAGE_CAPABILITY } from '../middleware/agentRbac';
import { db } from '../db';
import { auditService } from '../services/audit.service';
import { agentService } from '../services/agent.service';
import { agentUpdateRollout } from '../services/agentUpdateRollout.service';
import { agentUpdatePolicyService } from '../services/agentUpdatePolicy.service';
import { isAgentUpdatePolicyInput } from '../utils/agentUpdate';

const router = Router();

// All tenant routes require auth
router.use(requireAuth);

// ── Locate an entity across the user's tenants ─────────────────────────────
// GET /api/tenants/locate/:kind/:id   kind = monitor | group | agent
//
// Resolves which tenant a monitor / group / agent device belongs to, used
// when the user follows a shared deep link (/monitor/42, /group/7,
// /agents/5) while connected to another workspace. "Does not exist" and "no
// access" collapse into the same 404 so the endpoint cannot be used to probe
// other workspaces' ids.
//
// Access mirrors the by-id read routes: platform admins always pass; anyone
// else must be a member of the entity's tenant AND hold read permission on it
// through their teams (monitor / group permission, an agent through its
// agent monitor — or the agents.manage capability in the device's tenant).
//
// Returns: { kind, id, tenantId, tenantName, currentTenantId }.
const LOCATE_KINDS = ['monitor', 'group', 'agent'] as const;
type LocateKind = typeof LOCATE_KINDS[number];
const MAX_PG_INT = 2_147_483_647;

router.get('/locate/:kind/:id', async (req, res, next) => {
  try {
    const kind = req.params.kind as LocateKind;
    if (!LOCATE_KINDS.includes(kind)) throw new AppError(400, 'Invalid kind');
    if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Invalid ID');
    const id = parseInt(req.params.id, 10);
    if (id <= 0 || id > MAX_PG_INT) throw new AppError(400, 'Invalid ID');

    const userId = req.session.userId!;
    const isPlatformAdmin = req.session.role === 'admin';
    const notFound = () => new AppError(404, 'Not found');

    const table = kind === 'monitor' ? 'monitors' : kind === 'group' ? 'monitor_groups' : 'agent_devices';
    const row = await db(table).where({ id }).select('tenant_id').first() as
      { tenant_id: number | null } | undefined;
    if (!row || row.tenant_id == null) throw notFound();
    const tenantId = row.tenant_id;

    let allowed = isPlatformAdmin;
    if (!allowed && await tenantService.userHasAccess(userId, tenantId)) {
      if (kind === 'monitor') {
        allowed = await permissionService.canReadMonitor(userId, id, false);
      } else if (kind === 'group') {
        allowed = await permissionService.canReadGroup(userId, id, false);
      } else {
        // Same rule as requireAgentDeviceRead, evaluated in the device's own
        // workspace: agent managers see every device (pending ones included),
        // others need read access to the device's agent monitor.
        allowed = await permissionService.userHasTenantCapability(userId, tenantId, AGENTS_MANAGE_CAPABILITY);
        if (!allowed) {
          const monitor = await db('monitors')
            .where({ agent_device_id: id, type: 'agent' })
            .orderBy('id')
            .select('id')
            .first() as { id: number } | undefined;
          if (monitor) allowed = await permissionService.canReadMonitor(userId, monitor.id, false);
        }
      }
    }
    if (!allowed) throw notFound();

    const tenant = await tenantService.getById(tenantId);
    if (!tenant) throw notFound();

    res.json({
      success: true,
      data: {
        kind,
        id,
        tenantId,
        tenantName: tenant.name,
        currentTenantId: req.session.currentTenantId ?? null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ── Tenant switch ──────────────────────────────────────────────────────────
// POST /api/tenant/switch  { tenantId: number }
router.post('/switch', async (req, res, next) => {
  try {
    const { tenantId } = req.body as { tenantId: number };
    if (!tenantId || typeof tenantId !== 'number') {
      throw new AppError(400, 'tenantId is required');
    }

    const userId = req.session.userId!;

    // The tenant must exist — for platform admins too (a session pointing at
    // a missing tenant fails every tenant-scoped insert on its FK).
    const tenant = await tenantService.getById(tenantId);
    if (!tenant) throw new AppError(404, 'Tenant not found');

    // Platform admins can switch to any tenant; others only to their own
    if (req.session.role !== 'admin') {
      const hasAccess = await tenantService.userHasAccess(userId, tenantId);
      if (!hasAccess) throw new AppError(403, 'Access denied to this tenant');
    }

    req.session.currentTenantId = tenantId;
    res.json({ success: true, data: { currentTenantId: tenantId } });
  } catch (err) {
    next(err);
  }
});

// ── List tenants ───────────────────────────────────────────────────────────
// GET /api/tenants  (admin: all, user: their tenants with role)
router.get('/', async (req, res, next) => {
  try {
    const userId = req.session.userId!;
    const isAdmin = req.session.role === 'admin';

    if (isAdmin) {
      const tenants = await tenantService.getAll();
      res.json({ success: true, data: tenants });
    } else {
      const tenants = await tenantService.getTenantsForUser(userId);
      res.json({ success: true, data: tenants });
    }
  } catch (err) {
    next(err);
  }
});

// ── Create tenant (platform admin only) ───────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const { name, slug } = req.body as { name: string; slug: string };
    if (!name || !slug) throw new AppError(400, 'name and slug are required');
    const tenant = await tenantService.create({ name, slug });
    res.status(201).json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Get one tenant ─────────────────────────────────────────────────────────
router.get('/:id', async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const tenant = await tenantService.getById(id);
    if (!tenant) throw new AppError(404, 'Tenant not found');

    // Non-admins can only see their own tenants
    if (req.session.role !== 'admin') {
      const hasAccess = await tenantService.userHasAccess(req.session.userId!, id);
      if (!hasAccess) throw new AppError(403, 'Access denied');
    }

    res.json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Update tenant (platform admin only) ───────────────────────────────────
router.put('/:id', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const id = parseInt(req.params.id);
    const { name, slug } = req.body as { name?: string; slug?: string };
    const tenant = await tenantService.update(id, { name, slug });
    if (!tenant) throw new AppError(404, 'Tenant not found');
    res.json({ success: true, data: tenant });
  } catch (err) {
    next(err);
  }
});

// ── Delete tenant (platform admin only, cannot delete tenant 1) ───────────
router.delete('/:id', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const id = parseInt(req.params.id);
    if (isMasterTenant(id)) throw new AppError(400, 'Cannot delete the default tenant');
    // Orchestrated: workers stopped, agent channels closed, scope-keyed rows
    // and SMTP servers removed, sessions on the tenant repaired.
    const deleted = await tenantService.delete(id);
    if (!deleted) throw new AppError(404, 'Tenant not found');
    clearGroupStatsCache();
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ── Agent update policy of a workspace ────────────────────────────────────
// GET  /api/tenants/:id/agent-update-policy  platform admin, or agents.manage
//      in that workspace (read-only for workspace admins)
// PUT  /api/tenants/:id/agent-update-policy  { updatePolicy } platform admin only
// Workspace level of global -> workspace -> group chain -> agent; null =
// inherit the global policy. 'off' freezes every agent of the workspace.
router.get('/:id/agent-update-policy', async (req, res, next) => {
  try {
    if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Invalid ID');
    const tenantId = parseInt(req.params.id, 10);
    if (tenantId <= 0 || tenantId > MAX_PG_INT) throw new AppError(400, 'Invalid ID');
    if (req.session.role !== 'admin') {
      const allowed = await tenantService.userHasAccess(req.session.userId!, tenantId)
        && await permissionService.userHasTenantCapability(req.session.userId!, tenantId, AGENTS_MANAGE_CAPABILITY);
      if (!allowed) throw new AppError(404, 'Tenant not found');
    }
    const ctx = await agentUpdatePolicyService.getTenantContext(tenantId);
    if (!ctx) throw new AppError(404, 'Tenant not found');
    res.json({ success: true, data: ctx });
  } catch (err) {
    next(err);
  }
});

router.put('/:id/agent-update-policy', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Platform admin required');
    if (!/^\d+$/.test(req.params.id)) throw new AppError(400, 'Invalid ID');
    const tenantId = parseInt(req.params.id, 10);
    if (tenantId <= 0 || tenantId > MAX_PG_INT) throw new AppError(400, 'Invalid ID');
    const body = (req.body ?? {}) as { updatePolicy?: unknown };
    if (!('updatePolicy' in body) || !isAgentUpdatePolicyInput(body.updatePolicy)) {
      throw new AppError(400, "updatePolicy must be 'auto', 'manual', 'off' or null");
    }
    const to = body.updatePolicy;
    const from = await agentUpdatePolicyService.setTenantPolicy(tenantId, to);
    if (from === undefined) throw new AppError(404, 'Tenant not found');
    if (from !== to) {
      await auditService.logReq(req, 'agent_update_policy.changed', {
        tenantId,
        resourceType: 'tenant',
        resourceId: tenantId,
        details: { level: 'tenant', scopeId: tenantId, from, to },
      });
    }
    // Workspace freeze: the updates still waiting in it are cancelled.
    if (to === 'off') {
      await agentUpdateRollout.cancelPending(tenantId);
    } else {
      agentUpdateRollout.nudge();
    }
    // Live lists show the new effective policy (bounded: a huge workspace
    // simply picks it up on its next refresh).
    if (from !== to) {
      const ids = await db('agent_devices').where({ tenant_id: tenantId }).limit(5000).pluck('id') as number[];
      if (ids.length > 0) await agentService.emitDevicesByIds(ids);
    }
    res.json({ success: true, data: await agentUpdatePolicyService.getTenantContext(tenantId) });
  } catch (err) {
    next(err);
  }
});

// ── Tenant members ─────────────────────────────────────────────────────────
// GET /api/tenants/:id/members
router.get('/:id/members', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const tenantId = parseInt(req.params.id);
    const members = await tenantService.getMembers(tenantId);
    res.json({ success: true, data: members });
  } catch (err) {
    next(err);
  }
});

// POST /api/tenants/:id/members  { userId, role? }
// `role` is a permission_set slug ('admin' | 'user' | 'viewer' | custom),
// validated against permission_sets. Defaults to 'user'.
router.post('/:id/members', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const tenantId = parseInt(req.params.id);
    const { userId, role } = req.body as { userId: number; role?: string };
    if (!userId) throw new AppError(400, 'userId is required');
    const resolvedRole = await resolveTenantRole(role);
    await tenantService.addUser(tenantId, userId, resolvedRole);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// PUT /api/tenants/:id/members/:uid  { role }
// `role` is a permission_set slug, validated against permission_sets.
router.put('/:id/members/:uid', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const tenantId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);
    const { role } = req.body as { role?: string };
    if (!role) throw new AppError(400, 'role is required');
    const resolvedRole = await resolveTenantRole(role);
    const updated = await tenantService.updateUserRole(tenantId, userId, resolvedRole);
    if (!updated) throw new AppError(404, 'User is not a member of this tenant');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/tenants/:id/members/:uid
router.delete('/:id/members/:uid', async (req, res, next) => {
  try {
    if (req.session.role !== 'admin') throw new AppError(403, 'Admin only');
    const tenantId = parseInt(req.params.id);
    const userId = parseInt(req.params.uid);
    // Also drops the user's memberships in the tenant's teams and ends their
    // sessions (currentTenantId, socket rooms, cached grants); platform
    // admins keep access to every workspace, so theirs are left alone.
    await tenantService.removeUser(tenantId, userId);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

export default router;
