import type { Request } from 'express';
import { isMasterTenant } from '@obliview/shared';
import { db } from '../db';
import { logger } from '../utils/logger';

/**
 * Audit log — "who did what, when, and from where".
 *
 * Action names are dotted (`<domain>.<verb>`: 'auth.login', 'team.created',
 * 'notification.channel_updated'…) so the UI can filter by prefix ('team.').
 * Never put secret values (passwords, tokens, API keys, SMTP credentials,
 * channel configs) in `details`: log the keys / names that changed instead.
 */

export interface AuditLogEntry {
  /** Workspace the action belongs to. null = platform-level action (only the
   *  master tenant's cross-tenant feed shows it). */
  tenantId: number | null;
  userId?: number | null;
  action: string;
  resourceType?: string;
  resourceId?: number | string | null;
  resourcePath?: string;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}

export interface AuditLogExtras {
  resourceType?: string;
  resourceId?: number | string | null;
  resourcePath?: string;
  details?: Record<string, unknown>;
  /** File the entry in this tenant instead of the request's one (e.g. a god
   *  view action on another tenant's team leaves a trace in that tenant's
   *  own log). null = platform-level. */
  tenantId?: number | null;
  /** Actor override (e.g. a refused sign-in has no session user yet). */
  userId?: number | null;
}

export interface AuditLogRow {
  id: number;
  tenantId: number | null;
  tenantName: string | null;
  userId: number | null;
  username: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  resourcePath: string | null;
  /** Display name resolved from the owning table (null when the entity was
   *  deleted or the resource type has no nameable table). */
  resourceName: string | null;
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AuditListFilters {
  /** Exact action, or a prefix ending with '.' ('team.' → every team action). */
  action?: string;
  userId?: number;
  resourceType?: string;
  search?: string;
  since?: Date;
  until?: Date;
  /** God view only (tenantId = null in list()): narrow the cross-tenant feed
   *  to one tenant. Ignored for a tenant-scoped caller. */
  filterTenantId?: number;
}

/** Days an audit row is kept before the retention purge removes it. */
export const AUDIT_RETENTION_DAYS = 365;

const MAX_DETAILS_CHARS = 16_000;
const PURGE_BATCH_SIZE = 10_000;

function rowToAudit(r: any): AuditLogRow {
  let details: Record<string, unknown> | null = null;
  if (r.details != null) {
    try {
      details = typeof r.details === 'string' ? JSON.parse(r.details) : r.details;
    } catch {
      details = null;
    }
  }
  return {
    id: r.id,
    tenantId: r.tenant_id ?? null,
    tenantName: r.tenant_name ?? null,
    userId: r.user_id ?? null,
    username: r.username ?? null,
    action: r.action,
    resourceType: r.resource_type ?? null,
    resourceId: r.resource_id ?? null,
    resourcePath: r.resource_path ?? null,
    resourceName: r.resource_name ?? null,
    details,
    ipAddress: r.ip_address ?? null,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
  };
}

/**
 * Resource display names through correlated subqueries, one per nameable
 * type. Each branch only runs when its resource_type matches, and compares
 * the PK with `CASE WHEN resource_id ~ '^[0-9]{1,9}$' THEN resource_id::int END`:
 * the PK index is used, and a non-numeric key (such as an app_config key) is
 * never cast (CASE guarantees the order; a plain AND would not).
 */
const RESOURCE_NAME_SQL = `
  COALESCE(
    (SELECT name     FROM monitors              WHERE al.resource_type = 'monitor'              AND monitors.id              = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM monitor_groups        WHERE al.resource_type = 'group'                AND monitor_groups.id        = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT COALESCE(name, hostname) FROM agent_devices WHERE al.resource_type = 'agent_device' AND agent_devices.id     = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM notification_channels WHERE al.resource_type = 'notification_channel' AND notification_channels.id = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM remediation_actions   WHERE al.resource_type = 'remediation_action'   AND remediation_actions.id   = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM maintenance_windows   WHERE al.resource_type = 'maintenance_window'   AND maintenance_windows.id   = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM smtp_servers          WHERE al.resource_type = 'smtp_server'          AND smtp_servers.id          = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT username FROM users                 WHERE al.resource_type = 'user'                 AND users.id                 = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM user_teams            WHERE al.resource_type = 'team'                 AND user_teams.id            = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END),
    (SELECT name     FROM tenants               WHERE al.resource_type = 'tenant'               AND tenants.id               = CASE WHEN al.resource_id ~ '^[0-9]{1,9}$' THEN al.resource_id::int END)
  ) AS resource_name
`;

function clientIp(req: Request): string | null {
  // app.set('trust proxy', 1): req.ip is the client seen by OUR proxy, never
  // a spoofable left-most X-Forwarded-For value.
  const ip = req.ip || req.socket?.remoteAddress || null;
  if (!ip) return null;
  return (ip.startsWith('::ffff:') ? ip.slice(7) : ip).slice(0, 45);
}

function serializeDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  try {
    const json = JSON.stringify(details);
    if (json.length <= MAX_DETAILS_CHARS) return json;
    return JSON.stringify({ truncated: true, preview: json.slice(0, MAX_DETAILS_CHARS) });
  } catch {
    return null;
  }
}

/**
 * tenantId = null → cross-tenant feed (god view: platform admin on the master
 * tenant; platform-level rows included), optionally narrowed by
 * filterTenantId. Otherwise only that tenant's rows (filterTenantId ignored).
 */
function applyFilters(q: any, tenantId: number | null, filters: AuditListFilters): void {
  if (tenantId !== null) {
    q.where('al.tenant_id', tenantId);
  } else if (filters.filterTenantId != null && Number.isInteger(filters.filterTenantId)) {
    q.where('al.tenant_id', filters.filterTenantId);
  }

  if (filters.action) {
    if (filters.action.endsWith('.')) q.where('al.action', 'like', `${filters.action.replace(/[%_\\]/g, '\\$&')}%`);
    else q.where('al.action', filters.action);
  }
  if (filters.userId != null && Number.isInteger(filters.userId)) q.where('al.user_id', filters.userId);
  if (filters.resourceType) q.where('al.resource_type', filters.resourceType);
  if (filters.since) q.where('al.created_at', '>=', filters.since);
  if (filters.until) q.where('al.created_at', '<=', filters.until);
  if (filters.search) {
    const like = `%${filters.search.replace(/[%_\\]/g, '\\$&')}%`;
    q.where((b: any) => {
      b.where('al.action', 'ilike', like)
        .orWhere('al.resource_path', 'ilike', like)
        .orWhere('al.resource_id', 'ilike', like)
        .orWhere('u.username', 'ilike', like)
        .orWhereRaw('al.details::text ILIKE ?', [like]);
    });
  }
}

export const auditService = {
  /** Write a raw audit entry. Never throws — auditing must not break the
   *  request being audited (table missing mid-migration, bad JSON…). */
  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await db('audit_logs').insert({
        tenant_id: entry.tenantId ?? null,
        user_id: entry.userId ?? null,
        action: String(entry.action).slice(0, 100),
        resource_type: entry.resourceType ? entry.resourceType.slice(0, 50) : null,
        resource_id: entry.resourceId != null ? String(entry.resourceId).slice(0, 100) : null,
        resource_path: entry.resourcePath ?? null,
        details: serializeDetails(entry.details),
        ip_address: entry.ipAddress ?? null,
      });
    } catch (err) {
      logger.warn({ err, action: entry.action }, 'audit log write failed');
    }
  },

  /** Route-handler helper: tenant, actor and IP come from the request.
   *  Tenant = req.tenantId (tenant-scoped routes), else the session's active
   *  tenant, else null (platform-level). Never throws. */
  async logReq(req: Request, action: string, extras: AuditLogExtras = {}): Promise<void> {
    try {
      const session = (req as any).session as { userId?: number; currentTenantId?: number } | undefined;
      const tenantId = extras.tenantId !== undefined
        ? extras.tenantId
        : (req.tenantId ?? session?.currentTenantId ?? null);
      const userId = extras.userId !== undefined ? extras.userId : (session?.userId ?? null);
      await this.log({
        tenantId,
        userId,
        action,
        resourceType: extras.resourceType,
        resourceId: extras.resourceId,
        resourcePath: extras.resourcePath,
        details: extras.details,
        ipAddress: clientIp(req),
      });
    } catch (err) {
      logger.warn({ err, action }, 'audit log write failed');
    }
  },

  /** Tenant-wide list with filters and pagination. tenantId = null is the
   *  cross-tenant feed of the god view (see applyFilters) — callers pass
   *  getEffectiveTenantScope(req). */
  async list(params: {
    tenantId: number | null;
    filters?: AuditListFilters;
    page?: { limit?: number; offset?: number };
  }): Promise<{ items: AuditLogRow[]; total: number }> {
    const filters = params.filters ?? {};
    const limit = Math.min(500, Math.max(1, Math.floor(params.page?.limit ?? 100)));
    const offset = Math.max(0, Math.floor(params.page?.offset ?? 0));

    const base = db('audit_logs as al')
      .leftJoin('users as u', 'u.id', 'al.user_id')
      .leftJoin('tenants as ten', 'ten.id', 'al.tenant_id');
    applyFilters(base, params.tenantId, filters);

    const countRow = await base.clone().count<{ c: string }[]>({ c: 'al.id' }).first();
    const total = parseInt(String((countRow as any)?.c ?? '0'), 10);

    const rows = await base
      .select('al.*', 'u.username', 'ten.name as tenant_name', db.raw(RESOURCE_NAME_SQL))
      .orderBy('al.created_at', 'desc')
      .orderBy('al.id', 'desc')
      .limit(limit)
      .offset(offset);

    return { items: rows.map(rowToAudit), total };
  },

  /** Distinct action names visible to the caller (filter dropdown). */
  async distinctActions(tenantId: number | null, filterTenantId?: number): Promise<string[]> {
    const q = db('audit_logs').distinct('action').orderBy('action', 'asc');
    if (tenantId !== null) {
      q.where({ tenant_id: tenantId });
    } else if (filterTenantId != null && Number.isInteger(filterTenantId)) {
      q.where({ tenant_id: filterTenantId });
    }
    const rows = await q;
    return rows.map((r: any) => r.action as string);
  },

  /** Deletes the trail of one tenant (on the master tenant: its own rows
   *  plus the platform-level ones — other tenants' trails are never wiped
   *  from here). Returns the number of rows removed. */
  async clear(tenantId: number): Promise<number> {
    if (isMasterTenant(tenantId)) {
      return db('audit_logs').where({ tenant_id: tenantId }).orWhereNull('tenant_id').delete();
    }
    return db('audit_logs').where({ tenant_id: tenantId }).delete();
  },
};

/**
 * Retention purge: deletes audit rows older than `days` (default 365), in
 * short batches. Returns the number of rows deleted. Never throws.
 */
export async function purgeOldAuditLogs(days: number = AUDIT_RETENTION_DAYS): Promise<number> {
  const safeDays = Number.isFinite(days) && days >= 1 ? Math.floor(days) : AUDIT_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000);
  let deleted = 0;
  try {
    for (;;) {
      const res = await db.raw(
        `DELETE FROM audit_logs WHERE id IN (
           SELECT id FROM audit_logs WHERE created_at < ? ORDER BY id LIMIT ${PURGE_BATCH_SIZE}
         )`,
        [cutoff],
      );
      const n = (res as any)?.rowCount ?? 0;
      deleted += n;
      if (n < PURGE_BATCH_SIZE) break;
    }
    if (deleted > 0) logger.info({ deleted, days: safeDays }, 'audit log retention purge');
  } catch (err) {
    logger.warn({ err }, 'audit log retention purge failed');
  }
  return deleted;
}

let retentionTimer: NodeJS.Timeout | null = null;

/** Runs the retention purge shortly after boot, then once a day. Idempotent;
 *  the timers never keep the process alive. */
export function startAuditRetentionJob(): void {
  if (retentionTimer) return;
  const boot = setTimeout(() => { void purgeOldAuditLogs(); }, 5 * 60 * 1000);
  boot.unref?.();
  retentionTimer = setInterval(() => { void purgeOldAuditLogs(); }, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();
}
