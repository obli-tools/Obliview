import type { Request, Response, NextFunction } from 'express';
import { notificationService, type BindingScope } from '../services/notification.service';
import { monitorService } from '../services/monitor.service';
import { db } from '../db';
import { smtpServerService } from '../services/smtpServer.service';
import { getPluginMetas } from '../notifications/registry';
import { AppError } from '../middleware/errorHandler';
import type {
  CreateChannelInput,
  UpdateChannelInput,
  AddBindingInput,
  RemoveBindingInput,
} from '../validators/notification.schema';
import { getEffectiveTenantScope, isGodView, assertInScope } from '../utils/tenantScope';
import { auditService } from '../services/audit.service';

export const notificationsController = {
  // GET /api/notifications/plugins — list available plugin types
  async plugins(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const metas = getPluginMetas();
      res.json({ success: true, data: metas });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels[?scope=group|monitor|agent&scopeId=N]
  // With a scope, only the channels usable by that entity's tenant (own +
  // shared) are listed — what a binding / maintenance window on it accepts.
  async listChannels(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope;
      const scopeId = req.query.scopeId !== undefined ? parseInt(String(req.query.scopeId), 10) : NaN;
      if ((scope === 'group' || scope === 'monitor' || scope === 'agent') && Number.isInteger(scopeId) && scopeId > 0) {
        const tenantId = await resolveScopeTenant(req, scope, scopeId);
        const channels = await notificationService.getAllChannels(tenantId);
        res.json({ success: true, data: channels });
        return;
      }
      const channels = await notificationService.getAllChannels(getEffectiveTenantScope(req));
      res.json({ success: true, data: channels });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/channels/:id — owned by or shared to the active tenant (god view: any)
  async getChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const channel = await notificationService.getChannelById(id, getEffectiveTenantScope(req));
      if (!channel) throw new AppError(404, 'Channel not found');
      res.json({ success: true, data: channel });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels
  async createChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as CreateChannelInput;
      await assertSmtpServerUsable(req, data.config, req.tenantId);
      const channel = await notificationService.createChannel({
        ...data,
        createdBy: req.session.userId!,
      }, req.tenantId);
      // Channel configs hold secrets (webhook URLs, tokens…): never logged.
      await auditService.logReq(req, 'notification.channel_created', {
        resourceType: 'notification_channel',
        resourceId: channel.id,
        details: { name: channel.name, type: channel.type },
      });
      res.status(201).json({ success: true, data: channel });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('Unknown notification')) {
        next(new AppError(400, err.message));
      } else {
        next(err);
      }
    }
  },

  // PUT /api/notifications/channels/:id — owner tenant only (god view: any)
  async updateChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const data = req.body as UpdateChannelInput;
      const ownerTenantId = await assertChannelOwned(req, id);
      await assertSmtpServerUsable(req, data.config, ownerTenantId);
      const channel = await notificationService.updateChannel(id, data, getEffectiveTenantScope(req));
      if (!channel) throw new AppError(404, 'Channel not found');
      await auditService.logReq(req, 'notification.channel_updated', {
        tenantId: ownerTenantId,
        resourceType: 'notification_channel',
        resourceId: id,
        details: { name: channel.name, fields: Object.keys(data ?? {}) },
      });
      res.json({ success: true, data: channel });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/notifications/channels/:id — owner tenant only (god view: any)
  async deleteChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const ownerTenantId = await assertChannelOwned(req, id);
      const before = await notificationService.getChannelById(id, getEffectiveTenantScope(req));
      const deleted = await notificationService.deleteChannel(id, getEffectiveTenantScope(req));
      if (!deleted) throw new AppError(404, 'Channel not found');
      await auditService.logReq(req, 'notification.channel_deleted', {
        tenantId: ownerTenantId,
        resourceType: 'notification_channel',
        resourceId: id,
        details: { name: before?.name ?? null, type: before?.type ?? null },
      });
      res.json({ success: true, message: 'Channel deleted' });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/channels/:id/test — any tenant that can use the channel
  async testChannel(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      const tenantScope = getEffectiveTenantScope(req);
      const channel = await notificationService.getChannelById(id, tenantScope);
      if (!channel) throw new AppError(404, 'Channel not found');
      await notificationService.testChannel(id, tenantScope);
      res.json({ success: true, message: 'Test notification sent' });
    } catch (err: unknown) {
      if (err instanceof AppError) {
        next(err);
      } else if (err instanceof Error) {
        next(new AppError(400, `Test failed: ${err.message}`));
      } else {
        next(err);
      }
    }
  },

  // GET /api/notifications/channels/:id/tenants — list tenant IDs the channel is shared to
  // (god view only: sharing a channel across workspaces is a platform-admin action,
  // and a workspace must not learn which other tenants exist)
  async getChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isGodViewRequest(req)) throw new AppError(403, 'Channel sharing requires a platform admin');
      const id = parseInt(req.params.id, 10);
      await assertChannelOwned(req, id);
      const tenantIds = await notificationService.getChannelTenants(id);
      res.json({ success: true, data: tenantIds });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/notifications/channels/:id/tenants — replace sharing list
  async setChannelTenants(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseInt(req.params.id, 10);
      // Pushing a channel into other workspaces is a platform-admin action
      // (god view): a workspace manager must not write into other tenants.
      if (!isGodViewRequest(req)) throw new AppError(403, 'Channel sharing requires a platform admin');
      const raw: unknown = req.body.tenantIds ?? [];
      if (!Array.isArray(raw) || !raw.every((t) => Number.isInteger(t) && t > 0)) {
        throw new AppError(400, 'tenantIds must be an array');
      }
      const ownerTenantId = await assertChannelOwned(req, id);
      const tenantIds = [...new Set(raw as number[])].filter((t) => t !== ownerTenantId);
      if (tenantIds.length > 0) {
        const found = await db('tenants').whereIn('id', tenantIds).pluck('id') as number[];
        if (found.length !== tenantIds.length) throw new AppError(400, 'Unknown tenant');
      }
      const updated = await notificationService.setChannelTenants(id, tenantIds, getEffectiveTenantScope(req));
      if (!updated) throw new AppError(404, 'Channel not found');
      await auditService.logReq(req, 'notification.channel_shared', {
        tenantId: ownerTenantId,
        resourceType: 'notification_channel',
        resourceId: id,
        details: { tenantIds },
      });
      res.json({ success: true, message: 'Channel tenants updated' });
    } catch (err) {
      next(err);
    }
  },

  // ── Bindings ──

  // GET /api/notifications/bindings?scope=...&scopeId=...
  async listBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope as string;
      const rawScopeId = req.query.scopeId as string | undefined;
      const scopeId = rawScopeId && rawScopeId !== 'null' ? parseInt(rawScopeId, 10) : null;
      if (!isBindingScope(scope)) throw new AppError(400, 'Invalid scope');
      if (scopeId !== null && isNaN(scopeId)) throw new AppError(400, 'Invalid scopeId');

      if (scope === 'global') {
        // 'global' = the workspace's own global layer. The god view also sees
        // the global bindings it wrote on behalf of other tenants' channels.
        const bindings = isGodViewRequest(req)
          ? await notificationService.getGlobalBindingsForGodView(req.tenantId)
          : await notificationService.getBindings('global', null, req.tenantId);
        res.json({ success: true, data: bindings });
        return;
      }

      if (scopeId === null) throw new AppError(400, 'scopeId is required for non-global scopes');
      const tenantId = await resolveScopeTenant(req, scope, scopeId);
      const bindings = await notificationService.getBindings(scope, scopeId, tenantId);
      res.json({ success: true, data: bindings });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/notifications/bindings
  async addBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as AddBindingInput;
      const tenantId = await resolveBindingTenant(req, data.channelId, data.scope, data.scopeId);

      const binding = await notificationService.addBinding(
        data.channelId,
        data.scope,
        data.scope === 'global' ? null : data.scopeId,
        data.overrideMode,
        tenantId,
      );
      await auditService.logReq(req, 'notification.binding_added', {
        tenantId,
        resourceType: 'notification_channel',
        resourceId: data.channelId,
        details: { scope: data.scope, scopeId: data.scope === 'global' ? null : data.scopeId, overrideMode: data.overrideMode },
      });
      res.status(201).json({ success: true, data: binding });
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/notifications/bindings
  async removeBinding(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const data = req.body as RemoveBindingInput;
      const tenantId = await resolveBindingTenant(req, data.channelId, data.scope, data.scopeId, false);

      const removed = await notificationService.removeBinding(
        data.channelId,
        data.scope,
        data.scope === 'global' ? null : data.scopeId,
        tenantId,
      );
      if (removed) {
        await auditService.logReq(req, 'notification.binding_removed', {
          tenantId,
          resourceType: 'notification_channel',
          resourceId: data.channelId,
          details: { scope: data.scope, scopeId: data.scope === 'global' ? null : data.scopeId },
        });
      }
      res.json({ success: true, message: removed ? 'Binding removed' : 'Binding not found' });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/notifications/bindings/resolved?scope=monitor|group|agent&scopeId=N
  async resolvedBindings(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const scope = req.query.scope as 'group' | 'monitor' | 'agent';
      const scopeId = parseInt(req.query.scopeId as string, 10);

      if (!scope || isNaN(scopeId)) {
        throw new AppError(400, 'Missing scope or scopeId');
      }
      if (!['group', 'monitor', 'agent'].includes(scope)) {
        throw new AppError(400, 'scope must be group, monitor or agent');
      }

      // Entity of another tenant → 404 (god view: resolve with the entity's tenant)
      const tenantId = await resolveScopeTenant(req, scope, scopeId);

      // Agent scope uses its own resolution method (global → agent group hierarchy → agent)
      if (scope === 'agent') {
        const resolved = await notificationService.resolveBindingsWithSourcesForAgent(scopeId, tenantId);
        res.json({ success: true, data: resolved });
        return;
      }

      // For monitor scope, we need the monitor's groupId for resolution
      let groupId: number | null = null;
      if (scope === 'monitor') {
        const monitor = await monitorService.getById(scopeId, tenantId);
        if (!monitor) throw new AppError(404, 'Monitor not found');
        groupId = monitor.groupId;
      }

      const resolved = await notificationService.resolveBindingsWithSources(scope, scopeId, groupId, tenantId);
      res.json({ success: true, data: resolved });
    } catch (err) {
      next(err);
    }
  },
};

// ── Tenant scoping helpers ──────────────────────────────────────────────────

function isBindingScope(scope: unknown): scope is BindingScope {
  return scope === 'global' || scope === 'group' || scope === 'monitor' || scope === 'agent';
}

/**
 * Write gate on a channel: it must be OWNED by the active tenant (god view:
 * any channel). Missing, foreign and merely-shared channels are all a 404 —
 * a shared channel is usable, never editable, by the tenants it is shared to.
 */
async function assertChannelOwned(req: Request, channelId: number): Promise<number> {
  if (!Number.isInteger(channelId) || channelId <= 0) throw new AppError(404, 'Channel not found');
  const ownerTenantId = await notificationService.getOwnedChannelTenantId(channelId, null);
  if (ownerTenantId === null) throw new AppError(404, 'Channel not found');
  assertInScope(req, ownerTenantId, 'Channel not found');
  return ownerTenantId;
}

/**
 * An smtp channel referencing a saved SMTP server (config.smtpServerId) may
 * only use a server of the channel's owner tenant — otherwise a workspace
 * could send through (and borrow the credentials of) another one's server.
 */
async function assertSmtpServerUsable(req: Request, config: unknown, ownerTenantId: number): Promise<void> {
  if (isGodViewRequest(req)) return; // platform admin on the master tenant: any server
  if (!config || typeof config !== 'object') return;
  const raw = (config as Record<string, unknown>).smtpServerId;
  if (raw === undefined || raw === null || raw === '') return;
  const serverId = Number(raw);
  const serverTenantId = Number.isInteger(serverId) && serverId > 0
    ? await smtpServerService.getTenantId(serverId)
    : undefined;
  if (serverTenantId === undefined || serverTenantId !== ownerTenantId) {
    throw new AppError(400, 'SMTP server not available in this workspace');
  }
}

/** God view = platform admin on the master tenant (getEffectiveTenantScope → null). */
function isGodViewRequest(req: Request): boolean {
  return getEffectiveTenantScope(req) === null;
}

/**
 * Tenant of a group / monitor / agent the request targets. An entity of
 * another tenant is a 404, except in the god view where its own tenant is used.
 */
async function resolveScopeTenant(
  req: Request,
  scope: 'group' | 'monitor' | 'agent',
  scopeId: number,
): Promise<number> {
  const label = scope === 'group' ? 'Group' : scope === 'monitor' ? 'Monitor' : 'Agent';
  const entityTenantId = await notificationService.getScopeTenantId(scope, scopeId);
  if (entityTenantId === null) throw new AppError(404, `${label} not found`);
  if (!isGodViewRequest(req) && entityTenantId !== req.tenantId) {
    throw new AppError(404, `${label} not found`);
  }
  return entityTenantId;
}

/**
 * Tenant a binding is written to / removed from, after authorisation:
 *  - global: the active tenant when the channel is owned by / shared to it;
 *    in the god view, the channel's owner tenant otherwise;
 *  - group / monitor / agent: the entity's tenant (404 if it is not the active
 *    tenant, except in the god view), and the channel must be owned by or
 *    shared to that tenant.
 * `checkChannel=false` (removal) skips the channel check on scoped bindings so
 * a binding left over by a revoked share can still be removed.
 */
async function resolveBindingTenant(
  req: Request,
  channelId: number,
  scope: BindingScope,
  scopeId: number | null,
  checkChannel = true,
): Promise<number> {
  if (scope === 'global') {
    const tenantId = await notificationService.resolveGlobalBindingTenant(channelId, req.tenantId, isGodViewRequest(req));
    if (tenantId === null) throw new AppError(404, 'Channel not found');
    return tenantId;
  }

  if (scopeId === null) throw new AppError(400, 'scopeId is required for non-global scopes');
  const tenantId = await resolveScopeTenant(req, scope, scopeId);
  if (checkChannel && !(await notificationService.isChannelUsableBy(channelId, tenantId))) {
    throw new AppError(404, 'Channel not found');
  }
  return tenantId;
}
