import type { Request, Response, NextFunction } from 'express';
import { appConfigService, OBLIGATE_INBOUND_SECRET_MIN_LENGTH } from '../services/appConfig.service';
import { AppError } from '../middleware/errorHandler';
import { smtpServerService } from '../services/smtpServer.service';
import { isMasterTenant } from '@obliview/shared';
import { auditService } from '../services/audit.service';
import { obligateService } from '../services/obligate.service';
import { agentUpdateRollout } from '../services/agentUpdateRollout.service';
import { invalidateAgentUpdatePolicyCache } from '../services/agentUpdatePolicy.service';
import { agentService } from '../services/agent.service';
import { isAgentUpdatePolicy, isAgentUpdatePolicyInput } from '../utils/agentUpdate';

const ALLOWED_KEYS = [
  'allow_2fa', 'force_2fa', 'otp_smtp_server_id',
  'obligate_enabled',
] as const;

export const appConfigController = {
  async getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAll();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async set(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const key = req.params.key as typeof ALLOWED_KEYS[number];
      if (!ALLOWED_KEYS.includes(key)) throw new AppError(400, `Unknown config key: ${key}`);
      const { value } = req.body;
      if (value === undefined) throw new AppError(400, 'Missing value');
      if (key === 'otp_smtp_server_id') {
        // The 2FA / password-reset server must be platform-level or of the
        // master workspace: a child workspace's admins could otherwise edit it.
        const otpId = Number(value);
        if (Number.isInteger(otpId) && otpId > 0) {
          const owner = await smtpServerService.getTenantId(otpId);
          if (owner === undefined) throw new AppError(404, 'SMTP server not found');
          if (owner !== null && !isMasterTenant(owner)) {
            throw new AppError(400, 'The two-factor / password-reset SMTP server must be platform-level or belong to the master workspace');
          }
        }
      }
      await appConfigService.set(key, String(value));
      // Platform-level setting. None of ALLOWED_KEYS holds a secret, so the new
      // value is kept (a future secret key must log the key only).
      await auditService.logReq(req, 'config.changed', {
        tenantId: null,
        resourceType: 'app_config',
        resourceId: key,
        details: { key, value: String(value) },
      });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** GET /admin/config/agent-global */
  async getAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getAgentGlobal();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  /** PATCH /admin/config/agent-global */
  async patchAgentGlobal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { checkIntervalSeconds, heartbeatMonitoring, maxMissedPushes, notificationTypes, updatePolicy } = req.body;
      const patch: Record<string, unknown> = {};
      const hasPolicy = 'updatePolicy' in req.body;
      if (hasPolicy && !isAgentUpdatePolicyInput(updatePolicy)) {
        throw new AppError(400, "updatePolicy must be 'auto', 'manual', 'off' or null");
      }
      const before = hasPolicy ? await appConfigService.getAgentGlobal() : null;
      if ('checkIntervalSeconds' in req.body) patch.checkIntervalSeconds = checkIntervalSeconds;
      if ('heartbeatMonitoring' in req.body) patch.heartbeatMonitoring = heartbeatMonitoring;
      if ('maxMissedPushes' in req.body) patch.maxMissedPushes = maxMissedPushes;
      if ('notificationTypes' in req.body) patch.notificationTypes = notificationTypes;
      // Global level of the agent update policy (null = built-in default 'manual').
      if (hasPolicy) patch.updatePolicy = updatePolicy ?? null;
      const updated = await appConfigService.setAgentGlobal(patch);
      const otherFields = Object.keys(patch).filter((k) => k !== 'updatePolicy');
      if (otherFields.length > 0) {
        await auditService.logReq(req, 'config.changed', {
          tenantId: null,
          resourceType: 'app_config',
          resourceId: 'agent_global',
          details: { key: 'agent_global', fields: otherFields },
        });
      }
      if (hasPolicy) {
        invalidateAgentUpdatePolicyCache();
        const from = isAgentUpdatePolicy(before?.updatePolicy) ? before!.updatePolicy : null;
        const to = (updatePolicy ?? null) as string | null;
        if (from !== to) {
          await auditService.logReq(req, 'agent_update_policy.changed', {
            tenantId: null,
            resourceType: 'app_config',
            resourceId: 'agent_global',
            details: { level: 'global', scopeId: null, from, to },
          });
        }
        // Fleet-wide freeze: every update still waiting is cancelled (one
        // already handed to an agent cannot be recalled).
        if (to === 'off') {
          await agentService.emitDevicesByIds(await agentUpdateRollout.cancelPending(null));
        } else {
          agentUpdateRollout.nudge();
        }
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────────

  async getObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const cfg = await appConfigService.getObligateConfig();
      res.json({ success: true, data: cfg });
    } catch (err) { next(err); }
  },

  async setObligateConfig(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const patch: { url?: string | null; apiKey?: string | null; enabled?: boolean; inboundSecret?: string | null } = {};
      if ('url' in body) patch.url = (typeof body.url === 'string' ? body.url.trim() : '') || null;
      if ('apiKey' in body) patch.apiKey = (typeof body.apiKey === 'string' ? body.apiKey.trim() : '') || null;
      if ('enabled' in body) patch.enabled = !!body.enabled;
      // Distinct inbound secret (Obligate → this server), write-only: a
      // non-empty string sets it (min. OBLIGATE_INBOUND_SECRET_MIN_LENGTH
      // characters), null clears it (the API key is expected again), an
      // empty string or no field keeps it.
      if ('inboundSecret' in body) {
        const s = body.inboundSecret;
        if (s !== null && typeof s !== 'string') throw new AppError(400, 'inboundSecret must be a string or null');
        if (s === null) {
          patch.inboundSecret = null;
        } else {
          const trimmed = s.trim();
          if (trimmed.length > 0 && trimmed.length < OBLIGATE_INBOUND_SECRET_MIN_LENGTH) {
            throw new AppError(400, `inboundSecret must be at least ${OBLIGATE_INBOUND_SECRET_MIN_LENGTH} characters`);
          }
          if (trimmed) patch.inboundSecret = trimmed;
        }
      }
      const updated = await appConfigService.patchObligateConfig(patch);
      // A new / changed link announces our accent color right away (not awaited).
      void obligateService.announceSelfInfo();
      // Never the API key / inbound secret themselves: only which fields
      // changed, and whether a secret was set or cleared.
      await auditService.logReq(req, 'obligate.config_changed', {
        tenantId: null,
        resourceType: 'app_config',
        resourceId: 'obligate',
        details: {
          fields: Object.keys(patch),
          ...(patch.url !== undefined ? { url: patch.url } : {}),
          ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
          ...(patch.apiKey !== undefined ? { apiKey: patch.apiKey ? 'set' : 'cleared' } : {}),
          ...(patch.inboundSecret !== undefined ? { inboundSecret: patch.inboundSecret ? 'set' : 'cleared' } : {}),
        },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },
};
