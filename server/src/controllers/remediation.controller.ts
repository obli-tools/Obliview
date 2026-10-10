import type { Request, Response, NextFunction } from 'express';
import {
  remediationService,
  REMEDIATION_ACTION_TYPES,
  isServerExecutedActionType,
  serverScriptsEnabled,
  normalizeHostKeyFingerprint,
  SERVER_SCRIPTS_DISABLED_ERROR,
} from '../services/remediation.service';
import { permissionService } from '../services/permission.service';
import { tenantService } from '../services/tenant.service';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateRemediationActionRequest,
  UpdateRemediationActionRequest,
  AddRemediationBindingRequest,
  OverrideModeR,
  RemediationTrigger,
  RemediationRun,
} from '@obliview/shared';
import { getEffectiveTenantScope, isGodView } from '../utils/tenantScope';
import { db } from '../db';
import { auditService } from '../services/audit.service';

// ── Access helpers ────────────────────────────────────────────────────────────

/** Strict positive integer parse for query/body ids (null when invalid) */
function parseId(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Resolve a group/monitor target and enforce read access to it:
 *   - it must belong to the active tenant (God View may target any tenant);
 *   - non-platform-admins must be able to read it via their teams.
 * Returns the target's owning tenant — the only tenant whose actions may be
 * reported for it.
 */
async function resolveReadableTarget(req: Request, scope: 'group' | 'monitor', scopeId: number) {
  const notFound = scope === 'monitor' ? 'Monitor not found' : 'Group not found';
  const target = await remediationService.getScopeTarget(scope, scopeId);
  if (!target) throw new AppError(404, notFound);
  if (!isGodView(req) && target.tenantId !== req.tenantId) throw new AppError(404, notFound);

  if (req.session.role !== 'admin') {
    const userId = req.session.userId!;
    const canRead = scope === 'monitor'
      ? await permissionService.canReadMonitor(userId, scopeId, false)
      : await permissionService.canReadGroup(userId, scopeId, false);
    if (!canRead) throw new AppError(403, 'Access denied');
  }
  return target;
}

/** Execution output (script stdout, SSH output, webhook responses) and errors are admin-only */
function stripRunOutput(run: RemediationRun): RemediationRun {
  return { ...run, output: null, error: null };
}

/**
 * Server-executed actions (script, ssh, docker_restart) run on or from the
 * Obliview server, outside every tenant boundary. Creating or updating one is
 * refused while REMEDIATION_ALLOW_SERVER_SCRIPTS=false (400 SERVER_SCRIPTS_DISABLED)
 * and, in any case, reserved to a platform admin on the master tenant.
 * Sends the refusal and returns true when the caller must stop.
 */
function refuseServerExecutedAction(req: Request, res: Response): boolean {
  if (!serverScriptsEnabled()) {
    res.status(400).json({ success: false, error: SERVER_SCRIPTS_DISABLED_ERROR, code: 'SERVER_SCRIPTS_DISABLED' });
    return true;
  }
  if (!isGodView(req)) {
    res.status(403).json({
      success: false,
      error: 'Only a platform admin on the master workspace can manage script, SSH and Docker actions',
    });
    return true;
  }
  return false;
}

/**
 * Binding / unbinding / deleting a server-executed action (script, ssh,
 * docker_restart) is reserved to the god view like creating it, but stays
 * possible while REMEDIATION_ALLOW_SERVER_SCRIPTS=false (cleanup).
 * Sends the refusal and returns true when the caller must stop.
 */
function refuseServerExecutedManagement(req: Request, res: Response): boolean {
  if (!isGodView(req)) {
    res.status(403).json({
      success: false,
      error: 'Only a platform admin on the master workspace can manage script, SSH and Docker actions',
    });
    return true;
  }
  return false;
}

/** Action type behind a binding (null when the binding does not exist). */
async function bindingActionType(bindingId: number): Promise<string | null> {
  const row = await db('remediation_bindings as b')
    .join('remediation_actions as a', 'a.id', 'b.action_id')
    .where('b.id', bindingId)
    .first('a.type') as { type: string } | undefined;
  return row?.type ?? null;
}

/** Action behind a binding, for the audit trail (null when the binding does not exist). */
async function bindingAuditInfo(bindingId: number): Promise<{ actionId: number; tenantId: number; scope: string; scopeId: number | null } | null> {
  if (!Number.isInteger(bindingId) || bindingId <= 0) return null;
  const row = await db('remediation_bindings as b')
    .join('remediation_actions as a', 'a.id', 'b.action_id')
    .where('b.id', bindingId)
    .first('b.action_id', 'a.tenant_id', 'b.scope', 'b.scope_id') as
    { action_id: number; tenant_id: number; scope: string; scope_id: number | null } | undefined;
  return row ? { actionId: row.action_id, tenantId: row.tenant_id, scope: row.scope, scopeId: row.scope_id } : null;
}

/** Non-negative integer cooldown (undefined passes through). */
function clampCooldown(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'cooldownSeconds must be a non-negative integer');
  return n;
}

/** Reject a malformed SSH host-key pin (an empty value means "not pinned") */
function assertValidHostKeyPin(config: Record<string, unknown> | undefined): void {
  const value = config?.hostKeySha256;
  if (value === undefined || value === null || value === '') return;
  if (normalizeHostKeyFingerprint(value) === null) {
    throw new AppError(400, 'Invalid host key fingerprint (expected SHA256:<base64>)');
  }
}

/** Action by id, visible from the active tenant (God View: any tenant) — 404 otherwise */
async function getOwnedAction(req: Request, rawId: unknown) {
  const id = parseId(rawId);
  const action = id !== null ? await remediationService.getActionById(id) : null;
  if (!action || (!isGodView(req) && action.tenantId !== req.tenantId)) {
    throw new AppError(404, 'Action not found');
  }
  return action;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

/**
 * GET /remediation/capabilities
 *   serverScriptsEnabled   — script / SSH / Docker actions may run on this server;
 *   canManageServerActions — the caller may create/update them (platform admin
 *                            on the master tenant), independently of the flag.
 */
export async function getCapabilities(req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      data: {
        serverScriptsEnabled: serverScriptsEnabled(),
        canManageServerActions: isGodView(req),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── Actions ────────────────────────────────────────────────────────────────────

export async function listActions(req: Request, res: Response, next: NextFunction) {
  try {
    const actions = await remediationService.listActions(getEffectiveTenantScope(req));
    res.json({ data: actions });
  } catch (err) {
    next(err);
  }
}

export async function createAction(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as CreateRemediationActionRequest;
    if (!body.name || !body.type || !body.config) {
      res.status(400).json({ error: 'name, type and config are required' });
      return;
    }
    if (!REMEDIATION_ACTION_TYPES.includes(body.type)) throw new AppError(400, 'Invalid type');
    if (typeof body.config !== 'object' || Array.isArray(body.config)) throw new AppError(400, 'Invalid config');
    if (isServerExecutedActionType(body.type) && refuseServerExecutedAction(req, res)) return;
    if (body.type === 'ssh') assertValidHostKeyPin(body.config);

    // Actions only ever run for monitors of their own tenant. God View may create one
    // directly in another tenant (e.g. "Create & Bind" on a monitor of that tenant);
    // everyone else creates in the active tenant.
    let tenantId = req.tenantId;
    if (body.tenantId !== undefined && body.tenantId !== null) {
      const requested = parseId(body.tenantId);
      if (requested === null) throw new AppError(400, 'Invalid tenantId');
      if (requested !== req.tenantId) {
        if (!isGodView(req)) throw new AppError(403, 'Cannot create an action in another tenant');
        if (!(await tenantService.getById(requested))) throw new AppError(404, 'Tenant not found');
        tenantId = requested;
      }
    }

    const action = await remediationService.createAction(body, tenantId);
    // The config may hold credentials / script bodies: only name and type are logged.
    await auditService.logReq(req, 'remediation.action_created', {
      tenantId,
      resourceType: 'remediation_action',
      resourceId: action.id,
      details: { name: action.name, type: action.type },
    });
    res.status(201).json({ data: action });
  } catch (err) {
    next(err);
  }
}

export async function updateAction(req: Request, res: Response, next: NextFunction) {
  try {
    const existing = await getOwnedAction(req, req.params.id);
    const body = req.body as UpdateRemediationActionRequest;
    if (body.config !== undefined && (body.config === null || typeof body.config !== 'object' || Array.isArray(body.config))) {
      throw new AppError(400, 'Invalid config');
    }
    // The type cannot change on update: the stored type decides the gate
    if (isServerExecutedActionType(existing.type) && refuseServerExecutedAction(req, res)) return;
    if (existing.type === 'ssh') assertValidHostKeyPin(body.config);

    const action = await remediationService.updateAction(existing.id, body);
    if (!action) { res.status(404).json({ error: 'Action not found' }); return; }
    await auditService.logReq(req, 'remediation.action_updated', {
      tenantId: existing.tenantId ?? req.tenantId,
      resourceType: 'remediation_action',
      resourceId: existing.id,
      details: { name: action.name, type: existing.type, fields: Object.keys(body ?? {}) },
    });
    res.json({ data: action });
  } catch (err) {
    next(err);
  }
}

export async function deleteAction(req: Request, res: Response, next: NextFunction) {
  try {
    // Deleting stays allowed for every type (also while server scripts are
    // disabled), but server-executed ones only from the god view.
    const existing = await getOwnedAction(req, req.params.id);
    if (isServerExecutedActionType(existing.type) && refuseServerExecutedManagement(req, res)) return;
    await remediationService.deleteAction(existing.id);
    await auditService.logReq(req, 'remediation.action_deleted', {
      tenantId: existing.tenantId ?? req.tenantId,
      resourceType: 'remediation_action',
      resourceId: existing.id,
      details: { name: existing.name, type: existing.type },
    });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ── SSH host key ──────────────────────────────────────────────────────────────

/**
 * POST /remediation/ssh/fingerprint { host, port }
 * Fetches the host key fingerprint to pin on an SSH action (the handshake is
 * aborted before authentication). Same gate as creating an SSH action.
 */
export async function fetchSshFingerprint(req: Request, res: Response, next: NextFunction) {
  try {
    if (refuseServerExecutedAction(req, res)) return;

    const { host: rawHost, port: rawPort } = (req.body ?? {}) as { host?: unknown; port?: unknown };
    const host = typeof rawHost === 'string' ? rawHost.trim() : '';
    if (!host || host.length > 255 || /[\s/\\]/.test(host)) throw new AppError(400, 'A valid host is required');

    let port = 22;
    if (rawPort !== undefined && rawPort !== null && rawPort !== '') {
      port = typeof rawPort === 'number' ? rawPort : typeof rawPort === 'string' ? Number(rawPort) : NaN;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError(400, 'Invalid port');
    }

    let result: { fingerprint: string; keyType: string | null };
    try {
      result = await remediationService.fetchSshHostKeyFingerprint(host, port);
    } catch (err) {
      throw new AppError(400, `Could not fetch the host key: ${err instanceof Error ? err.message : String(err)}`);
    }
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

// ── Bindings ──────────────────────────────────────────────────────────────────

/** GET /remediation/bindings?scope=monitor&scopeId=42 */
export async function getBindings(req: Request, res: Response, next: NextFunction) {
  try {
    const { scope, scopeId } = req.query as { scope?: string; scopeId?: string };
    if (!scope) throw new AppError(400, 'scope query param required');

    if (scope === 'global') {
      // Global bindings are tenant-wide: only those of the active tenant's actions (God View: all)
      const bindings = await remediationService.getBindings('global', null, getEffectiveTenantScope(req));
      res.json({ data: bindings });
      return;
    }
    if (scope !== 'group' && scope !== 'monitor') throw new AppError(400, 'Invalid scope');

    const id = parseId(scopeId);
    if (id === null) throw new AppError(400, 'scopeId required');
    const target = await resolveReadableTarget(req, scope, id);

    // God View also sees stale bindings to other tenants' actions (they never run) so
    // the platform admin can clean them up; everyone else only the target tenant's.
    const bindings = await remediationService.getBindings(scope, id, isGodView(req) ? null : target.tenantId);
    res.json({ data: bindings, tenantId: target.tenantId });
  } catch (err) {
    next(err);
  }
}

/** GET /remediation/resolved?scope=monitor&scopeId=42&groupId=5 */
export async function getResolved(req: Request, res: Response, next: NextFunction) {
  try {
    const { scope, scopeId, groupId } = req.query as {
      scope?: string; scopeId?: string; groupId?: string;
    };
    if (!scope || !scopeId) throw new AppError(400, 'scope and scopeId required');
    if (scope !== 'group' && scope !== 'monitor') throw new AppError(400, 'Invalid scope');

    const id = parseId(scopeId);
    if (id === null) throw new AppError(400, 'Invalid scopeId');
    const target = await resolveReadableTarget(req, scope, id);

    // Inheritance chain: a monitor always inherits from its real group (client value
    // ignored); for a group, an explicit groupId must be the group itself or an ancestor.
    let chainGroupId: number | null = null;
    if (scope === 'monitor') {
      chainGroupId = target.groupId;
    } else if (groupId) {
      const gid = parseId(groupId);
      if (gid === null || !(await remediationService.isGroupAncestorOrSelf(gid, id))) {
        throw new AppError(400, 'Invalid groupId');
      }
      chainGroupId = gid;
    }

    const resolved = await remediationService.resolveBindingsWithSources(
      scope,
      id,
      chainGroupId,
      target.tenantId,
    );
    // tenantId: the only tenant whose actions can be bound to this target (lets the
    // God View UI offer / create actions in the right tenant)
    res.json({ data: resolved, tenantId: target.tenantId });
  } catch (err) {
    next(err);
  }
}

/** POST /remediation/bindings */
export async function addBinding(req: Request, res: Response, next: NextFunction) {
  try {
    const body = req.body as AddRemediationBindingRequest;
    if (!body.actionId || !body.scope) {
      res.status(400).json({ error: 'actionId and scope are required' });
      return;
    }
    if (body.scope !== 'global' && body.scope !== 'group' && body.scope !== 'monitor') {
      throw new AppError(400, 'Invalid scope');
    }

    // Bindings only ever fire for monitors of the action's own tenant, so reject
    // bindings that could never apply instead of storing them silently.
    const actionId = parseId(body.actionId);
    const action = actionId !== null ? await remediationService.getActionById(actionId) : null;
    const actionTenantId = action ? action.tenantId : null;
    if (!action || actionTenantId === null || (!isGodView(req) && actionTenantId !== req.tenantId)) {
      throw new AppError(404, 'Action not found');
    }
    // Binding a script / SSH / Docker action makes it fire: same gate as creating one.
    if (isServerExecutedActionType(action.type) && refuseServerExecutedAction(req, res)) return;
    const cooldownSeconds = clampCooldown(body.cooldownSeconds);
    let scopeId: number | null = null;
    if (body.scope !== 'global') {
      scopeId = parseId(body.scopeId);
      const target = scopeId !== null ? await remediationService.getScopeTarget(body.scope, scopeId) : null;
      if (!target) throw new AppError(404, body.scope === 'monitor' ? 'Monitor not found' : 'Group not found');
      if (target.tenantId !== actionTenantId) {
        throw new AppError(400, 'Action and target belong to different tenants');
      }
    }

    const binding = await remediationService.addBinding({
      ...body,
      actionId: actionId!,
      scopeId,
      ...(cooldownSeconds !== undefined && { cooldownSeconds }),
    });
    await auditService.logReq(req, 'remediation.binding_added', {
      tenantId: actionTenantId,
      resourceType: 'remediation_action',
      resourceId: action.id,
      details: { bindingId: binding.id, scope: body.scope, scopeId, triggerOn: body.triggerOn ?? null },
    });
    res.status(201).json({ data: binding });
  } catch (err) {
    next(err);
  }
}

/** PATCH /remediation/bindings/:id */
export async function updateBinding(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const { overrideMode, triggerOn, cooldownSeconds } = req.body as {
      overrideMode?: OverrideModeR;
      triggerOn?: RemediationTrigger;
      cooldownSeconds?: number;
    };
    const actionType = await bindingActionType(id);
    if (actionType && isServerExecutedActionType(actionType) && refuseServerExecutedManagement(req, res)) return;
    const binding = await remediationService.updateBinding(id, {
      overrideMode, triggerOn, cooldownSeconds: clampCooldown(cooldownSeconds),
    });
    if (!binding) { res.status(404).json({ error: 'Binding not found' }); return; }
    const info = await bindingAuditInfo(id);
    await auditService.logReq(req, 'remediation.binding_updated', {
      ...(info ? { tenantId: info.tenantId } : {}),
      resourceType: 'remediation_action',
      resourceId: info?.actionId ?? null,
      details: { bindingId: id, fields: Object.keys(req.body ?? {}) },
    });
    res.json({ data: binding });
  } catch (err) {
    next(err);
  }
}

/** DELETE /remediation/bindings/:id */
export async function deleteBinding(req: Request, res: Response, next: NextFunction) {
  try {
    const id = Number(req.params.id);
    const actionType = await bindingActionType(id);
    if (actionType && isServerExecutedActionType(actionType) && refuseServerExecutedManagement(req, res)) return;
    const info = await bindingAuditInfo(id);
    await remediationService.deleteBinding(id);
    if (info) {
      await auditService.logReq(req, 'remediation.binding_deleted', {
        tenantId: info.tenantId,
        resourceType: 'remediation_action',
        resourceId: info.actionId,
        details: { bindingId: id, scope: info.scope, scopeId: info.scopeId },
      });
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// ── Run history ───────────────────────────────────────────────────────────────

/** GET /remediation/runs?monitorId=42 | ?actionId=7 */
export async function getRuns(req: Request, res: Response, next: NextFunction) {
  try {
    const { monitorId, actionId } = req.query as { monitorId?: string; actionId?: string };
    const isAdmin = req.session.role === 'admin';

    if (monitorId) {
      const id = parseId(monitorId);
      if (id === null) throw new AppError(400, 'Invalid monitorId');
      const target = await resolveReadableTarget(req, 'monitor', id);
      const runs = await remediationService.getRunsForMonitor(id, target.tenantId);
      res.json({ data: isAdmin ? runs : runs.map(stripRunOutput) });
      return;
    }
    if (actionId) {
      // Actions are admin-managed (see /actions) — so is their run history
      if (!isAdmin) throw new AppError(403, 'Insufficient permissions');
      const id = parseId(actionId);
      if (id === null) throw new AppError(400, 'Invalid actionId');
      const actionTenantId = await remediationService.getActionTenantId(id);
      if (actionTenantId === null || (!isGodView(req) && actionTenantId !== req.tenantId)) {
        throw new AppError(404, 'Action not found');
      }
      const runs = await remediationService.getRunsForAction(id);
      res.json({ data: runs });
      return;
    }
    throw new AppError(400, 'monitorId or actionId required');
  } catch (err) {
    next(err);
  }
}
