import { Router, type Request } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin, requireTenantCapability } from '../middleware/rbac';
import { asyncHandler } from '../utils/asyncHandler';
import { auditService, type AuditListFilters } from '../services/audit.service';
import { getEffectiveTenantScope } from '../utils/tenantScope';

// Mounted on the tenantRouter (requireAuth + requireTenant) at /audit-log.
const router = Router();

router.use(requireAuth);

// Reading the trail: tenant capability 'supervision:read' (platform admins and
// tenant admins always pass). The god view (platform admin on the master
// tenant) gets the cross-tenant feed, platform-level rows included; anyone
// else only the active tenant's rows.
const requireAuditRead = requireTenantCapability('supervision:read');

function parseIntParam(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const n = parseInt(v, 10);
  return Number.isInteger(n) ? n : undefined;
}

function parseDateParam(v: unknown): Date | undefined {
  if (typeof v !== 'string' || v === '') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseStringParam(v: unknown, max = 200): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s.slice(0, max) : undefined;
}

function filtersFrom(req: Request): AuditListFilters {
  return {
    action: parseStringParam(req.query.action, 100),
    userId: parseIntParam(req.query.userId),
    resourceType: parseStringParam(req.query.resourceType, 50),
    search: parseStringParam(req.query.search),
    since: parseDateParam(req.query.since),
    until: parseDateParam(req.query.until),
    // God-view-only narrow filter — ignored for a tenant-scoped caller.
    filterTenantId: parseIntParam(req.query.filterTenantId),
  };
}

// GET /api/audit-log?action=team.&userId=&since=&until=&search=&limit=50&offset=0
router.get('/', requireAuditRead, asyncHandler(async (req, res) => {
  const { items, total } = await auditService.list({
    tenantId: getEffectiveTenantScope(req),
    filters: filtersFrom(req),
    page: {
      limit: parseIntParam(req.query.limit) ?? 100,
      offset: parseIntParam(req.query.offset) ?? 0,
    },
  });
  res.json({ success: true, data: { items, total } });
}));

// GET /api/audit-log/distinct-actions — action filter dropdown
router.get('/distinct-actions', requireAuditRead, asyncHandler(async (req, res) => {
  const actions = await auditService.distinctActions(getEffectiveTenantScope(req), parseIntParam(req.query.filterTenantId));
  res.json({ success: true, data: actions });
}));

// DELETE /api/audit-log — clear the active tenant's trail. Platform admins
// only: 'supervision:read' grants visibility, never the right to destroy
// accountability records. A single 'audit.cleared' row is written afterwards
// so the wipe itself leaves a trace.
router.delete('/', requirePlatformAdmin(), asyncHandler(async (req, res) => {
  const deleted = await auditService.clear(req.tenantId);
  await auditService.logReq(req, 'audit.cleared', {
    resourceType: 'audit_log',
    details: { entriesDeleted: deleted },
  });
  res.json({ success: true, data: { deleted } });
}));

export default router;
