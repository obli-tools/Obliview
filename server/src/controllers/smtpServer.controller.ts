import type { Request, Response, NextFunction } from 'express';
import { smtpServerService } from '../services/smtpServer.service';
import { AppError } from '../middleware/errorHandler';
import { getEffectiveTenantScope, assertInScope } from '../utils/tenantScope';
import { permissionService } from '../services/permission.service';
import { auditService } from '../services/audit.service';

/** Machine-readable code of a refused delete (the server sends the 2FA / password-reset emails). */
const SMTP_SERVER_IN_USE_OTP = 'SMTP_SERVER_IN_USE_OTP';

function parseId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new AppError(404, 'SMTP server not found');
  return id;
}

/**
 * :id must belong to the active workspace. Platform-level servers
 * (tenant_id NULL) and other workspaces' servers are only reachable from the
 * god view (platform admin on the master workspace). Same 404 either way, so
 * ids of other workspaces cannot be probed.
 */
async function assertServerAccess(req: Request, id: number): Promise<number | null> {
  const tenantId = await smtpServerService.getTenantId(id);
  if (tenantId === undefined) throw new AppError(404, 'SMTP server not found');
  assertInScope(req, tenantId, 'SMTP server not found');
  return tenantId;
}

/**
 * The platform-wide 2FA / password-reset server may only be changed by a
 * platform admin: a workspace 'settings' holder pointing it at their own relay
 * would receive every user's reset links and email OTP codes.
 */
async function assertNotOtpUnlessPlatformAdmin(req: Request, id: number): Promise<void> {
  if (req.session?.role === 'admin') return;
  if ((await smtpServerService.getOtpServerId()) === id) {
    throw new AppError(
      403,
      'This SMTP server sends the two-factor codes and password-reset emails; only a platform admin can change it.',
      SMTP_SERVER_IN_USE_OTP,
    );
  }
}

export const smtpServerController = {
  /**
   * GET /admin/smtp-servers — the active workspace's servers.
   * GET /admin/smtp-servers?scope=otp — candidates for the platform-wide 2FA /
   * password-reset server (platform-level + master workspace, plus the one
   * currently configured), with their owner tenantId. Platform admins only.
   */
  async list(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (req.query.scope === 'otp') {
        if (req.session?.role !== 'admin') throw new AppError(403, 'Forbidden');
        const otpId = await smtpServerService.getOtpServerId();
        const servers = await smtpServerService.listOtpCandidates(otpId);
        res.json({ success: true, data: servers });
        return;
      }
      // Always the active workspace's own servers (the god view does not fan out here).
      const servers = await smtpServerService.list(req.tenantId);
      const fullRows = req.session?.role === 'admin'
        || await permissionService.userHasTenantCapability(req.session.userId!, req.tenantId, 'settings');
      // 'notifications'-only callers (channel-form picker): no host / credentials.
      const data = fullRows ? servers : servers.map((s) => ({ id: s.id, name: s.name, fromAddress: s.fromAddress }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async create(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { name, host, port, secure, username, password, fromAddress } = req.body;
      if (!name || !host || !port || !username || !password || !fromAddress) {
        throw new AppError(400, 'Missing required fields');
      }
      const server = await smtpServerService.create({ name, host, port: Number(port), secure: Boolean(secure), username, password, fromAddress, tenantId: req.tenantId });
      // Never the username / password.
      await auditService.logReq(req, 'smtp.server_created', {
        resourceType: 'smtp_server',
        resourceId: server.id,
        details: { name, host, port: Number(port), fromAddress },
      });
      res.status(201).json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async update(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      const ownerTenantId = await assertServerAccess(req, id);
      await assertNotOtpUnlessPlatformAdmin(req, id);
      const { name, host, port, secure, username, password, fromAddress } = req.body;
      const server = await smtpServerService.update(id, {
        ...(name !== undefined && { name }),
        ...(host !== undefined && { host }),
        ...(port !== undefined && { port: Number(port) }),
        ...(secure !== undefined && { secure: Boolean(secure) }),
        ...(username !== undefined && { username }),
        ...(password !== undefined && { password }),
        ...(fromAddress !== undefined && { fromAddress }),
      }, getEffectiveTenantScope(req));
      if (!server) throw new AppError(404, 'SMTP server not found');
      // Field names only (credentials never logged).
      await auditService.logReq(req, 'smtp.server_updated', {
        tenantId: ownerTenantId,
        resourceType: 'smtp_server',
        resourceId: id,
        details: {
          name: server.name,
          fields: ['name', 'host', 'port', 'secure', 'username', 'password', 'fromAddress'].filter((k) => req.body?.[k] !== undefined),
        },
      });
      res.json({ success: true, data: server });
    } catch (err) { next(err); }
  },

  async delete(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = parseId(req.params.id);
      const ownerTenantId = await assertServerAccess(req, id);
      await assertNotOtpUnlessPlatformAdmin(req, id);
      // Deleting the server of the 2FA codes / password-reset emails would
      // silently break them for every workspace: pick another one first.
      if ((await smtpServerService.getOtpServerId()) === id) {
        throw new AppError(
          409,
          'This SMTP server sends the two-factor codes and password-reset emails. Select another server in Settings (Platform) first.',
          SMTP_SERVER_IN_USE_OTP,
        );
      }
      const removed = await smtpServerService.delete(id, getEffectiveTenantScope(req));
      if (!removed) throw new AppError(404, 'SMTP server not found');
      await auditService.logReq(req, 'smtp.server_deleted', {
        tenantId: ownerTenantId,
        resourceType: 'smtp_server',
        resourceId: id,
      });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async test(req: Request, res: Response, next: NextFunction): Promise<void> {
    let id: number;
    try {
      id = parseId(req.params.id);
      await assertServerAccess(req, id);
      await assertNotOtpUnlessPlatformAdmin(req, id);
    } catch (err) { next(err); return; }
    try {
      await smtpServerService.test(id, getEffectiveTenantScope(req));
      res.json({ success: true, message: 'Connection successful' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connection failed';
      next(new AppError(400, `SMTP test failed: ${msg}`));
    }
  },
};
