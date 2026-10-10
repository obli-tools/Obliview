import { db } from '../db';
import type { AppConfig, AgentGlobalConfig, NotificationTypeConfig, ObligateConfig } from '@obliview/shared';
import { DEFAULT_NOTIFICATION_TYPES } from '@obliview/shared';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

const AGENT_GLOBAL_CONFIG_KEY = 'agent_global_config';
const OBLIGATE_CONFIG_KEY     = 'obligate_config';

// ── Obligate settings helpers ─────────────────────────────────────────────
// Inbound secret: an optional secret, distinct from the API key, that
// Obligate must present (Bearer) on its calls to this server (sso-user-sync,
// app-info, dashboard-stats). Resolution order:
//   OBLIGATE_INBOUND_SECRET (environment) → the Settings value → the API key
//   (the historical behaviour, kept while no inbound secret is set).
// Never returned to any client: the admin UI only sees whether one is set.

/** Minimum length of an inbound secret set from the Settings page. */
export const OBLIGATE_INBOUND_SECRET_MIN_LENGTH = 16;

interface ObligateStored {
  url: string | null;
  apiKey: string | null;
  inboundSecret: string | null;
}

/** Obligate config as shown to admins: flags only, never a secret. */
export type ObligateConfigView = ObligateConfig & {
  /** An inbound secret is in force (environment or Settings). */
  inboundSecretSet: boolean;
  /** It comes from OBLIGATE_INBOUND_SECRET (read-only in the UI). */
  inboundSecretFromEnv: boolean;
};

let warnedShortEnvSecret = false;
function envInboundSecret(): string | null {
  const v = process.env.OBLIGATE_INBOUND_SECRET?.trim();
  if (!v) return null;
  if (v.length < OBLIGATE_INBOUND_SECRET_MIN_LENGTH && !warnedShortEnvSecret) {
    warnedShortEnvSecret = true;
    logger.warn(`OBLIGATE_INBOUND_SECRET is shorter than ${OBLIGATE_INBOUND_SECRET_MIN_LENGTH} characters — use a long random secret`);
  }
  return v;
}

function obligatePublicView(s: ObligateStored, enabled: boolean): ObligateConfigView {
  const envSecret = envInboundSecret();
  return {
    url: s.url,
    apiKeySet: !!s.apiKey,
    enabled,
    inboundSecretSet: !!(envSecret ?? s.inboundSecret),
    inboundSecretFromEnv: !!envSecret,
  };
}

export const appConfigService = {
  async get(key: string): Promise<string | null> {
    const row = await db('app_config').where({ key }).first('value');
    return row?.value ?? null;
  },

  async set(key: string, value: string): Promise<void> {
    await db('app_config')
      .insert({ key, value })
      .onConflict('key')
      .merge({ value });
  },

  async getAll(): Promise<AppConfig> {
    const rows = await db('app_config').select('key', 'value');
    const map = Object.fromEntries(rows.map((r: { key: string; value: string }) => [r.key, r.value]));

    /** Extract only the URL from a JSON config blob (never expose apiKey) */
    const parseUrl = (key: string): string | null => {
      if (!map[key]) return null;
      try { return (JSON.parse(map[key]) as { url?: string }).url || null; } catch { return null; }
    };

    return {
      allow_2fa: map['allow_2fa'] === 'true',
      force_2fa: map['force_2fa'] === 'true',
      otp_smtp_server_id: map['otp_smtp_server_id'] ? parseInt(map['otp_smtp_server_id'], 10) : null,
      obligate_url:     parseUrl(OBLIGATE_CONFIG_KEY),
      obligate_enabled: map['obligate_enabled'] === 'true',
    };
  },

  // ── Obligate SSO gateway ───────────────────────────────────────────────

  async getObligateConfig(): Promise<ObligateConfigView> {
    const enabled = (await this.get('obligate_enabled')) === 'true';
    return obligatePublicView(await this.readObligateStored(), enabled);
  },

  /**
   * Obligate settings as stored (app_config 'obligate_config'), without the
   * environment override. Internal: callers use getObligateRaw().
   */
  async readObligateStored(): Promise<ObligateStored> {
    const raw = await this.get(OBLIGATE_CONFIG_KEY);
    if (!raw) return { url: null, apiKey: null, inboundSecret: null };
    try {
      const cfg = JSON.parse(raw) as { url?: string; apiKey?: string; inboundSecret?: unknown };
      return {
        url: cfg.url ?? null,
        apiKey: cfg.apiKey ?? null,
        inboundSecret: typeof cfg.inboundSecret === 'string' && cfg.inboundSecret ? cfg.inboundSecret : null,
      };
    } catch { return { url: null, apiKey: null, inboundSecret: null }; }
  },

  /**
   * Effective Obligate settings (environment override applied). Server-side
   * only — never send this object to a client.
   *  - apiKey: outbound Bearer (this server → Obligate) and, while no inbound
   *    secret is set, the Bearer expected from Obligate.
   *  - inboundSecret: the distinct secret expected from Obligate, if any.
   */
  async getObligateRaw(): Promise<{ url: string | null; apiKey: string | null; inboundSecret: string | null }> {
    const s = await this.readObligateStored();
    return { url: s.url, apiKey: s.apiKey, inboundSecret: envInboundSecret() ?? s.inboundSecret };
  },

  /**
   * Merge-patch the Obligate settings.
   *  - apiKey: a non-empty value replaces it (empty / null keeps it).
   *  - inboundSecret: a string of at least OBLIGATE_INBOUND_SECRET_MIN_LENGTH
   *    characters sets it, null clears it (the API key is expected again),
   *    absent keeps it. The environment override is never written here.
   */
  async patchObligateConfig(patch: {
    url?: string | null; apiKey?: string | null; enabled?: boolean;
    inboundSecret?: string | null;
  }): Promise<ObligateConfigView> {
    let inboundSecret: string | null | undefined;
    if ('inboundSecret' in patch) {
      if (patch.inboundSecret === null || patch.inboundSecret === undefined) {
        inboundSecret = null;
      } else {
        const trimmed = typeof patch.inboundSecret === 'string' ? patch.inboundSecret.trim() : '';
        if (trimmed.length < OBLIGATE_INBOUND_SECRET_MIN_LENGTH) {
          throw new AppError(400, `inboundSecret must be at least ${OBLIGATE_INBOUND_SECRET_MIN_LENGTH} characters`);
        }
        inboundSecret = trimmed;
      }
    }
    const existing = await this.readObligateStored();
    const merged: ObligateStored = {
      url: 'url' in patch ? (patch.url ?? null) : existing.url,
      apiKey: ('apiKey' in patch && patch.apiKey) ? patch.apiKey : existing.apiKey,
      inboundSecret: inboundSecret !== undefined ? inboundSecret : existing.inboundSecret,
    };
    const toStore: Record<string, unknown> = { url: merged.url, apiKey: merged.apiKey };
    if (merged.inboundSecret) toStore.inboundSecret = merged.inboundSecret;
    await this.set(OBLIGATE_CONFIG_KEY, JSON.stringify(toStore));
    if ('enabled' in patch) {
      await this.set('obligate_enabled', patch.enabled ? 'true' : 'false');
    }
    const enabled = (await this.get('obligate_enabled')) === 'true';
    return obligatePublicView(merged, enabled);
  },

  /** Get global agent defaults from app_config */
  async getAgentGlobal(): Promise<AgentGlobalConfig> {
    const raw = await this.get(AGENT_GLOBAL_CONFIG_KEY);
    if (!raw) {
      return {
        checkIntervalSeconds: null,
        heartbeatMonitoring: null,
        maxMissedPushes: null,
        notificationTypes: null,
      };
    }
    try {
      return JSON.parse(raw) as AgentGlobalConfig;
    } catch {
      return {
        checkIntervalSeconds: null,
        heartbeatMonitoring: null,
        maxMissedPushes: null,
        notificationTypes: null,
      };
    }
  },

  /** Merge-patch global agent defaults */
  async setAgentGlobal(patch: Partial<AgentGlobalConfig>): Promise<AgentGlobalConfig> {
    const current = await this.getAgentGlobal();
    const updated: AgentGlobalConfig = { ...current, ...patch };
    await this.set(AGENT_GLOBAL_CONFIG_KEY, JSON.stringify(updated));
    return updated;
  },

  /**
   * Read the global notification types (fully resolved — each field falls back to
   * DEFAULT_NOTIFICATION_TYPES when null).
   */
  async getResolvedAgentNotificationTypes(): Promise<{
    global: boolean; down: boolean; up: boolean; alert: boolean; update: boolean;
  }> {
    const cfg = await this.getAgentGlobal();
    const nt: NotificationTypeConfig | null = cfg.notificationTypes ?? null;
    return {
      global: nt?.global ?? DEFAULT_NOTIFICATION_TYPES.global,
      down:   nt?.down   ?? DEFAULT_NOTIFICATION_TYPES.down,
      up:     nt?.up     ?? DEFAULT_NOTIFICATION_TYPES.up,
      alert:  nt?.alert  ?? DEFAULT_NOTIFICATION_TYPES.alert,
      update: nt?.update ?? DEFAULT_NOTIFICATION_TYPES.update,
    };
  },
};
