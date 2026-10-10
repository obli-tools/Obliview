import crypto from 'crypto';
import { exec } from 'child_process';
import http from 'http';
import net from 'net';
import { Client as SshClient } from 'ssh2';
import { db } from '../db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { auditService } from './audit.service';
import { AppError } from '../middleware/errorHandler';
import type {
  RemediationAction,
  RemediationActionSummary,
  RemediationBinding,
  ResolvedRemediationBinding,
  ResolvedRemediationBindingView,
  RemediationRun,
  RemediationActionType,
  RemediationTrigger,
  OverrideModeR,
  WebhookRemediationConfig,
  ScriptRemediationConfig,
  DockerRestartRemediationConfig,
  SshRemediationConfig,
  CreateRemediationActionRequest,
  UpdateRemediationActionRequest,
  AddRemediationBindingRequest,
} from '@obliview/shared';

// ─── DB row types ─────────────────────────────────────────────────────────────

interface ActionRow {
  id: number;
  name: string;
  type: string;
  config: unknown;
  enabled: boolean;
  tenant_id: number;
  created_at: Date;
  updated_at: Date;
}

interface BindingRow {
  id: number;
  action_id: number;
  scope: string;
  scope_id: number | null;
  override_mode: string;
  trigger_on: string;
  cooldown_seconds: number;
}

interface RunRow {
  id: number;
  action_id: number;
  monitor_id: number;
  triggered_by: string;
  status: string;
  output: string | null;
  error: string | null;
  duration_ms: number | null;
  triggered_at: Date;
  action_name?: string;
}

// ─── Mappers ──────────────────────────────────────────────────────────────────

function rowToAction(row: ActionRow): RemediationAction {
  const cfg = typeof row.config === 'string' ? JSON.parse(row.config) : row.config;
  // Never expose raw SSH credential — replace with masked sentinel
  if (row.type === 'ssh' && cfg && typeof cfg === 'object' && 'credentialEnc' in cfg && cfg.credentialEnc) {
    (cfg as Record<string, unknown>).credentialEnc = '[set]';
  }
  return {
    id: row.id,
    name: row.name,
    type: row.type as RemediationActionType,
    config: cfg as RemediationAction['config'],
    enabled: row.enabled,
    tenantId: row.tenant_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** Config-free view — safe to return outside the admin action CRUD */
function rowToActionSummary(row: Pick<ActionRow, 'id' | 'name' | 'type' | 'enabled'>): RemediationActionSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type as RemediationActionType,
    enabled: row.enabled,
  };
}

function rowToBinding(row: BindingRow): RemediationBinding {
  return {
    id: row.id,
    actionId: row.action_id,
    scope: row.scope as RemediationBinding['scope'],
    scopeId: row.scope_id,
    overrideMode: row.override_mode as OverrideModeR,
    triggerOn: row.trigger_on as RemediationTrigger,
    cooldownSeconds: row.cooldown_seconds,
  };
}

function rowToRun(row: RunRow): RemediationRun {
  return {
    id: row.id,
    actionId: row.action_id,
    monitorId: row.monitor_id,
    triggeredBy: row.triggered_by as 'down' | 'up',
    status: row.status as RemediationRun['status'],
    output: row.output,
    error: row.error,
    durationMs: row.duration_ms,
    triggeredAt: row.triggered_at.toISOString(),
    actionName: row.action_name,
  };
}

// ─── Shell quoting ────────────────────────────────────────────────────────────

/**
 * Strict single-quote quoting: the shell takes the value literally ($(),
 * backticks and $VAR are not interpreted). Quotes AND backslashes are emitted
 * outside the quotes as \' / \\ — fish (unlike POSIX sh) still honours \' and
 * \\ inside single quotes, so neither may appear there. Single pass, so the
 * produced sequences are never re-escaped. Safe for sh, bash, dash, zsh, ksh
 * and fish. Every monitor-derived value placed in a shell command line must
 * go through this.
 */
function shellQuote(value: unknown): string {
  return "'" + String(value).replace(/['\\]/g, c => (c === "'" ? "'\\''" : "'\\\\'")) + "'";
}

/**
 * Restrict a user-controlled value to characters that are inert in every common
 * remote shell, including non-POSIX ones where single quotes do not quote
 * (Windows cmd.exe: & | % ^; PowerShell: typographic quotes, $, `).
 * Anything else becomes '_'.
 */
function shellSafeChars(value: string): string {
  return value.replace(/[^\p{L}\p{M}\p{N} ._:/@+=,-]/gu, '_');
}

// ─── Action types & server-execution gate ────────────────────────────────────

export const REMEDIATION_ACTION_TYPES: readonly RemediationActionType[] = [
  'webhook', 'n8n', 'script', 'docker_restart', 'ssh',
];

/**
 * Types that execute on, or from, the Obliview server itself (a shell script,
 * the local Docker socket, an SSH session opened by the server) — i.e. outside
 * every tenant boundary.
 */
export const SERVER_EXECUTED_ACTION_TYPES: readonly RemediationActionType[] = ['script', 'ssh', 'docker_restart'];

export function isServerExecutedActionType(type: string): boolean {
  return (SERVER_EXECUTED_ACTION_TYPES as readonly string[]).includes(type);
}

/**
 * REMEDIATION_ALLOW_SERVER_SCRIPTS gates the server-executed types. They stay
 * enabled unless the variable is exactly "false", so existing deployments keep
 * running their actions after an upgrade.
 */
export function serverScriptsEnabled(): boolean {
  return process.env.REMEDIATION_ALLOW_SERVER_SCRIPTS !== 'false';
}

export const SERVER_SCRIPTS_DISABLED_ERROR =
  'Script, SSH and Docker remediation actions are disabled on this server (REMEDIATION_ALLOW_SERVER_SCRIPTS=false)';

/**
 * The only server environment variables a remediation script inherits. Never
 * spread process.env: it holds DATABASE_URL, SESSION_SECRET, ENCRYPTION_KEY,
 * DEFAULT_ADMIN_PASSWORD, …, and script output is stored and shown in the UI.
 */
const SCRIPT_ENV_ALLOWLIST = ['PATH', 'HOME', 'LANG', 'TZ'] as const;

// ─── SSH host-key pinning ─────────────────────────────────────────────────────

const HOST_KEY_MISMATCH_ERROR = 'Host key changed or not pinned';

/** Refusal of an SSH action write that carries no (fresh) host-key pin. */
function sshPinRequired(): AppError {
  return new AppError(400, 'Host key pin required: fetch the fingerprint first', 'SSH_HOST_KEY_REQUIRED');
}

/** OpenSSH-style fingerprint of a raw SSH host public key blob: "SHA256:<base64, unpadded>" */
function sshHostKeyFingerprint(key: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
}

/** Key algorithm at the head of an SSH public key blob (e.g. "ssh-ed25519"), null if unreadable */
function sshHostKeyType(key: Buffer): string | null {
  if (key.length < 4) return null;
  const len = key.readUInt32BE(0);
  if (len === 0 || len > 64 || 4 + len > key.length) return null;
  const type = key.toString('ascii', 4, 4 + len);
  return /^[\x21-\x7e]+$/.test(type) ? type : null;
}

/**
 * Canonical "SHA256:<43 base64 chars>" form of a host-key fingerprint ("SHA256:"
 * prefix optional, base64 padding tolerated). Null when empty or malformed.
 */
export function normalizeHostKeyFingerprint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (/^sha256:/i.test(s)) s = s.slice(7);
  s = s.replace(/=+$/, '');
  return /^[A-Za-z0-9+/]{43}$/.test(s) ? `SHA256:${s}` : null;
}

/**
 * Trust on first use, only for SSH actions that predate host-key pinning and
 * have no pin yet (no hostKeyStrict marker): store the key seen on their first
 * run. Every SSH action written since (create, update, Import) is strict and
 * never reaches this. Never overwrites an existing pin.
 */
async function pinHostKeyIfUnset(actionId: number, fingerprint: string): Promise<void> {
  await db('remediation_actions')
    .where({ id: actionId, type: 'ssh' })
    .whereRaw(`jsonb_typeof(config) = 'object'`)
    .whereRaw(`COALESCE(config->>'hostKeySha256', '') = ''`)
    .update({ config: db.raw(`config || jsonb_build_object('hostKeySha256', ?::text)`, [fingerprint]) });
}

// ─── SSH Credential Encryption (AES-256-GCM) ─────────────────────────────────

const SSH_SALT = 'remediation-ssh';

/**
 * Secrets an install may have run with before SESSION_SECRET became mandatory
 * (old compose default, config fallback). Credentials encrypted under them are
 * still readable after the secret changes, then re-encrypted with the current key.
 */
const LEGACY_CREDENTIAL_SECRETS = ['change-this-in-production', 'dev-secret-change-me'];

function currentCredentialSecret(): string {
  // An empty ENCRYPTION_KEY (compose passes ${ENCRYPTION_KEY:-}) counts as unset.
  return (process.env.ENCRYPTION_KEY || config.sessionSecret) as string;
}

/**
 * Previous secrets set by an operator during a rotation (SESSION_SECRET_PREVIOUS,
 * ENCRYPTION_KEY_PREVIOUS): credentials still encrypted under them are read,
 * then re-encrypted with the current key.
 */
function previousCredentialSecrets(): string[] {
  return [process.env.ENCRYPTION_KEY_PREVIOUS, process.env.SESSION_SECRET_PREVIOUS]
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

function deriveKeyFrom(secret: string): Buffer {
  return crypto.scryptSync(secret, SSH_SALT, 32);
}

function deriveKey(): Buffer {
  return deriveKeyFrom(currentCredentialSecret());
}

function encryptCredential(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptCredential(enc: string, key: Buffer = deriveKey()): string {
  const parts = enc.split(':');
  if (parts.length !== 3) throw new Error('Invalid credential format');
  const [ivB64, tagB64, ctB64] = parts;
  const iv  = Buffer.from(ivB64,  'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct  = Buffer.from(ctB64,  'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct).toString('utf8') + decipher.final('utf8');
}

/**
 * Decrypt with the current key; if that fails, try the legacy default secrets.
 * `legacy` is true when an old secret worked, so the caller can re-encrypt.
 */
function decryptCredentialWithLegacyFallback(enc: string): { plaintext: string; legacy: boolean } {
  try {
    return { plaintext: decryptCredential(enc), legacy: false };
  } catch (err) {
    const current = currentCredentialSecret();
    const tried = new Set<string>([current]);
    for (const secret of [...previousCredentialSecrets(), ...LEGACY_CREDENTIAL_SECRETS]) {
      if (tried.has(secret)) continue;
      tried.add(secret);
      try {
        return { plaintext: decryptCredential(enc, deriveKeyFrom(secret)), legacy: true };
      } catch { /* try the next one */ }
    }
    throw err;
  }
}

// ─── Inheritance helper (mirrors notification.service) ───────────────────────

type BindingSet = Map<number, RemediationBinding>; // actionId → binding

function applyBindings(current: BindingSet, bindings: RemediationBinding[]): BindingSet {
  if (bindings.length === 0) return current;
  const next = new Map(current);

  const hasReplace = bindings.some(b => b.overrideMode === 'replace');
  if (hasReplace) next.clear();

  for (const b of bindings) {
    if (b.overrideMode !== 'exclude') next.set(b.actionId, b);
  }
  for (const b of bindings) {
    if (b.overrideMode === 'exclude') next.delete(b.actionId);
  }
  return next;
}

// ─── Run result ───────────────────────────────────────────────────────────────

interface RunResult {
  status: 'success' | 'failed' | 'timeout';
  output?: string;
  error?: string;
}

// ─── Main service ─────────────────────────────────────────────────────────────

export const remediationService = {

  // ── Action CRUD ─────────────────────────────────────────────────────────────

  async listActions(tenantId: number | null): Promise<RemediationAction[]> {
    const query = db<ActionRow>('remediation_actions').orderBy('name');
    if (tenantId !== null) query.where({ tenant_id: tenantId });
    const rows = await query;
    return rows.map(rowToAction);
  },

  async getActionById(id: number): Promise<RemediationAction | null> {
    const row = await db<ActionRow>('remediation_actions').where({ id }).first();
    return row ? rowToAction(row) : null;
  },

  async createAction(data: CreateRemediationActionRequest, tenantId: number): Promise<RemediationAction> {
    let cfg = { ...data.config };

    // Encrypt SSH credential on create
    if (data.type === 'ssh' && cfg.credential && typeof cfg.credential === 'string') {
      cfg = { ...cfg, credentialEnc: encryptCredential(cfg.credential), credential: undefined };
      delete cfg.credential;
    }
    // Pinned host key, stored in canonical form. Required: a new SSH action
    // never trusts a key on first use (hostKeyStrict marks it).
    if (data.type === 'ssh') {
      const pin = normalizeHostKeyFingerprint(cfg.hostKeySha256);
      if (!pin) throw sshPinRequired();
      cfg.hostKeySha256 = pin;
      cfg.hostKeyStrict = true;
    }

    const [row] = await db<ActionRow>('remediation_actions')
      .insert({
        name: data.name,
        type: data.type,
        config: JSON.stringify(cfg) as unknown as Record<string, unknown>,
        enabled: data.enabled ?? true,
        tenant_id: tenantId,
      })
      .returning('*');
    return rowToAction(row);
  },

  async updateAction(id: number, data: UpdateRemediationActionRequest): Promise<RemediationAction | null> {
    const upd: Record<string, unknown> = { updated_at: new Date() };
    if (data.name    !== undefined) upd.name    = data.name;
    if (data.enabled !== undefined) upd.enabled = data.enabled;

    if (data.config !== undefined) {
      // Fetch existing to preserve credentialEnc when no new credential provided
      const existing = await db<ActionRow>('remediation_actions').where({ id }).first();
      if (!existing) return null;

      const existingCfg = typeof existing.config === 'string'
        ? JSON.parse(existing.config)
        : { ...(existing.config as Record<string, unknown>) };

      let newCfg = { ...existingCfg, ...data.config };

      if (existing.type === 'ssh') {
        const sent = data.config as Record<string, unknown>;
        const newCred = sent.credential;
        if (newCred && typeof newCred === 'string') {
          // New credential provided — encrypt and store
          newCfg = { ...newCfg, credentialEnc: encryptCredential(newCred) };
        }
        delete newCfg.credential; // never persist plaintext

        // A pinned host key belongs to one host:port: an endpoint change needs a
        // freshly fetched fingerprint, and every SSH write must carry a pin.
        // Edited actions become strict (no trust on first use).
        const endpointChanged =
          String(newCfg.host ?? '') !== String(existingCfg.host ?? '') ||
          Number(newCfg.port ?? 22) !== Number(existingCfg.port ?? 22);
        const sentPin = normalizeHostKeyFingerprint(sent.hostKeySha256);
        if (endpointChanged && (sentPin === null || sentPin === normalizeHostKeyFingerprint(existingCfg.hostKeySha256))) {
          throw sshPinRequired();
        }
        const pin = normalizeHostKeyFingerprint(newCfg.hostKeySha256);
        if (!pin) throw sshPinRequired();
        newCfg.hostKeySha256 = pin;
        newCfg.hostKeyStrict = true;
      }
      upd.config = JSON.stringify(newCfg);
    }

    const [row] = await db<ActionRow>('remediation_actions')
      .where({ id })
      .update(upd)
      .returning('*');
    return row ? rowToAction(row) : null;
  },

  async deleteAction(id: number): Promise<void> {
    await db('remediation_actions').where({ id }).delete();
  },

  // ── Binding CRUD ─────────────────────────────────────────────────────────────

  /**
   * List the bindings at a scope. remediation_bindings has no tenant_id: the
   * bound action's tenant is authoritative, so when `tenantId` is given only
   * bindings of that tenant's actions are returned ("global" = tenant-wide).
   * `tenantId = null` means no tenant filter (God View / admin writes).
   */
  async getBindings(scope: string, scopeId: number | null, tenantId: number | null = null): Promise<RemediationBinding[]> {
    const query = db('remediation_bindings as b')
      .where('b.scope', scope)
      .select('b.*');
    if (scopeId === null) {
      query.whereNull('b.scope_id');
    } else {
      query.where('b.scope_id', scopeId);
    }
    if (tenantId !== null) {
      query
        .join('remediation_actions as a', 'a.id', 'b.action_id')
        .where('a.tenant_id', tenantId);
    }
    const rows = (await query) as BindingRow[];
    return rows.map(rowToBinding);
  },

  /** Tenant (and, for a monitor, its group) owning a binding target — null if it does not exist */
  async getScopeTarget(
    scope: 'group' | 'monitor',
    scopeId: number,
  ): Promise<{ tenantId: number; groupId: number | null } | null> {
    if (scope === 'monitor') {
      const row = await db('monitors').where({ id: scopeId }).select('tenant_id', 'group_id').first() as
        { tenant_id: number; group_id: number | null } | undefined;
      return row ? { tenantId: row.tenant_id, groupId: row.group_id } : null;
    }
    const row = await db('monitor_groups').where({ id: scopeId }).select('tenant_id').first() as
      { tenant_id: number } | undefined;
    return row ? { tenantId: row.tenant_id, groupId: null } : null;
  },

  async isGroupAncestorOrSelf(ancestorId: number, descendantId: number): Promise<boolean> {
    const row = await db('group_closure')
      .where({ ancestor_id: ancestorId, descendant_id: descendantId })
      .first();
    return !!row;
  },

  async getActionTenantId(actionId: number): Promise<number | null> {
    const row = await db('remediation_actions').where({ id: actionId }).select('tenant_id').first() as
      { tenant_id: number } | undefined;
    return row ? row.tenant_id : null;
  },

  async addBinding(data: AddRemediationBindingRequest): Promise<RemediationBinding> {
    const [row] = await db<BindingRow>('remediation_bindings')
      .insert({
        action_id:       data.actionId,
        scope:           data.scope,
        scope_id:        data.scopeId ?? null,
        override_mode:   data.overrideMode   ?? 'merge',
        trigger_on:      data.triggerOn      ?? 'down',
        cooldown_seconds: data.cooldownSeconds ?? 300,
      })
      .returning('*');
    return rowToBinding(row);
  },

  async updateBinding(
    id: number,
    data: { overrideMode?: OverrideModeR; triggerOn?: RemediationTrigger; cooldownSeconds?: number },
  ): Promise<RemediationBinding | null> {
    const upd: Record<string, unknown> = {};
    if (data.overrideMode    !== undefined) upd.override_mode     = data.overrideMode;
    if (data.triggerOn       !== undefined) upd.trigger_on        = data.triggerOn;
    if (data.cooldownSeconds !== undefined) upd.cooldown_seconds  = data.cooldownSeconds;
    if (Object.keys(upd).length === 0) return this.getBindingById(id);
    const [row] = await db<BindingRow>('remediation_bindings').where({ id }).update(upd).returning('*');
    return row ? rowToBinding(row) : null;
  },

  async getBindingById(id: number): Promise<RemediationBinding | null> {
    const row = await db<BindingRow>('remediation_bindings').where({ id }).first();
    return row ? rowToBinding(row) : null;
  },

  async deleteBinding(id: number): Promise<void> {
    await db('remediation_bindings').where({ id }).delete();
  },

  // ── Resolution (walk global → group ancestors → monitor) ───────────────────

  async resolveBindingsForMonitor(
    monitorId: number,
    groupId: number | null,
  ): Promise<ResolvedRemediationBinding[]> {
    // Tenant isolation: only actions owned by the monitor's tenant may run for it,
    // so a binding (including a "global" one) made in tenant A never fires for tenant B.
    const monitorRow = await db('monitors').where({ id: monitorId }).select('tenant_id').first() as
      { tenant_id: number } | undefined;
    if (!monitorRow) return [];
    const tenantId = monitorRow.tenant_id;

    // 1. Global
    let set: BindingSet = new Map();
    const globalBindings = await this.getBindings('global', null, tenantId);
    set = applyBindings(set, globalBindings);

    // 2. Group ancestors (root → nearest)
    if (groupId !== null) {
      type AncestorRow = { ancestor_id: number; depth: number };
      const ancestorRows = await db<AncestorRow>('group_closure')
        .where('descendant_id', groupId)
        .orderBy('depth', 'desc');

      for (const row of ancestorRows) {
        const groupBindings = await this.getBindings('group', row.ancestor_id, tenantId);
        set = applyBindings(set, groupBindings);
      }
    }

    // 3. Monitor
    const monitorBindings = await this.getBindings('monitor', monitorId, tenantId);
    set = applyBindings(set, monitorBindings);

    if (set.size === 0) return [];

    // Fetch actions (tenant filter again as defense in depth)
    const actionIds = Array.from(set.keys());
    const actionRows = await db<ActionRow>('remediation_actions')
      .whereIn('id', actionIds)
      .where({ enabled: true, tenant_id: tenantId });
    const actionsById = new Map(actionRows.map(r => [r.id, rowToAction(r)]));

    const result: ResolvedRemediationBinding[] = [];
    for (const [actionId, binding] of set) {
      const action = actionsById.get(actionId);
      if (!action) continue; // disabled or deleted
      result.push({ ...binding, action });
    }
    return result;
  },

  /**
   * resolveBindingsWithSources — used by the UI to show inheritance info.
   * Only bindings of `tenantId`'s actions are considered (same rule as execution),
   * and actions are returned as config-free summaries.
   */
  async resolveBindingsWithSources(
    scope: 'group' | 'monitor',
    scopeId: number,
    groupId: number | null,
    tenantId: number,
  ): Promise<ResolvedRemediationBindingView[]> {
    interface SourceEntry {
      binding: RemediationBinding;
      source: 'global' | 'group' | 'monitor';
      sourceId: number | null;
      isDirect: boolean;
    }

    const result: Map<number, SourceEntry> = new Map();

    const applyWithSource = (
      bindings: RemediationBinding[],
      source: SourceEntry['source'],
      sourceId: number | null,
      isDirect: boolean,
    ) => {
      if (bindings.length === 0) return;
      const hasReplace = bindings.some(b => b.overrideMode === 'replace');
      if (hasReplace) result.clear();
      for (const b of bindings) {
        if (b.overrideMode !== 'exclude') {
          result.set(b.actionId, { binding: b, source, sourceId, isDirect });
        }
      }
      for (const b of bindings) {
        if (b.overrideMode === 'exclude') result.delete(b.actionId);
      }
    };

    const globalBindings = await this.getBindings('global', null, tenantId);
    applyWithSource(globalBindings, 'global', null, false);

    if (groupId != null) {
      type AncestorRow = { ancestor_id: number; depth: number };
      const ancestorRows = await db<AncestorRow>('group_closure')
        .where('descendant_id', groupId)
        .orderBy('depth', 'desc');
      for (const row of ancestorRows) {
        const gBindings = await this.getBindings('group', row.ancestor_id, tenantId);
        applyWithSource(gBindings, 'group', row.ancestor_id, false);
      }
    }

    if (scope === 'monitor') {
      const mBindings = await this.getBindings('monitor', scopeId, tenantId);
      applyWithSource(mBindings, 'monitor', scopeId, true);
    } else {
      // scope === 'group' — direct bindings
      const mBindings = await this.getBindings('group', scopeId, tenantId);
      applyWithSource(mBindings, 'group', scopeId, true);
    }

    if (result.size === 0) return [];

    const actionIds = Array.from(result.keys());
    const actionRows = await db<ActionRow>('remediation_actions')
      .whereIn('id', actionIds)
      .where({ tenant_id: tenantId })
      .select('id', 'name', 'type', 'enabled');
    const actionsById = new Map(actionRows.map(r => [r.id, rowToActionSummary(r)]));

    const views: ResolvedRemediationBindingView[] = [];
    for (const { binding, source, sourceId, isDirect } of result.values()) {
      const action = actionsById.get(binding.actionId);
      if (!action) continue; // deleted or not in this tenant
      views.push({ ...binding, action, source, sourceId, isDirect });
    }
    return views;
  },

  // ── Run history ──────────────────────────────────────────────────────────────

  /** Runs for a monitor — restricted to actions of `tenantId` (the monitor's tenant) */
  async getRunsForMonitor(monitorId: number, tenantId: number, limit = 50): Promise<RemediationRun[]> {
    const rows = await db<RunRow & { action_name: string }>('remediation_runs as r')
      .join('remediation_actions as a', 'a.id', 'r.action_id')
      .where('r.monitor_id', monitorId)
      .where('a.tenant_id', tenantId)
      .select('r.*', 'a.name as action_name')
      .orderBy('r.triggered_at', 'desc')
      .limit(limit);
    return rows.map(rowToRun);
  },

  async getRunsForAction(actionId: number, limit = 50): Promise<RemediationRun[]> {
    const rows = await db<RunRow>('remediation_runs')
      .where({ action_id: actionId })
      .orderBy('triggered_at', 'desc')
      .limit(limit);
    return rows.map(rowToRun);
  },

  // ── SSH host key ──────────────────────────────────────────────────────────────

  /**
   * Connect to host:port only far enough to receive the server's host key, then
   * abort the key exchange: no authentication is attempted and no credential is
   * sent. Returns the OpenSSH-style "SHA256:..." fingerprint to pin.
   */
  async fetchSshHostKeyFingerprint(
    host: string,
    port: number,
    timeoutMs = 10_000,
  ): Promise<{ fingerprint: string; keyType: string | null }> {
    return new Promise((resolve, reject) => {
      const conn = new SshClient();
      let captured: { fingerprint: string; keyType: string | null } | null = null;
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { conn.end(); } catch { /* ignore */ }
        if (captured) resolve(captured);
        else reject(err ?? new Error('The server closed the connection before sending its host key'));
      };

      const timer = setTimeout(
        () => finish(new Error(`Timed out after ${timeoutMs}ms waiting for the host key`)),
        timeoutMs + 1000,
      );

      // Rejecting the key below surfaces as an 'error' ("Host denied") — expected
      conn.on('error', (err) => finish(err));
      conn.on('close', () => finish());
      conn.on('ready', () => finish());

      try {
        conn.connect({
          host,
          port,
          username: 'obliview-hostkey-probe',
          readyTimeout: timeoutMs,
          hostVerifier: (key: Buffer): boolean => {
            captured = { fingerprint: sshHostKeyFingerprint(key), keyType: sshHostKeyType(key) };
            return false; // abort before authentication
          },
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  },

  // ── Trigger ───────────────────────────────────────────────────────────────────

  async triggerForMonitor(
    monitorId: number,
    monitorName: string,
    monitorUrl: string | undefined,
    monitorType: string,
    groupId: number | null,
    oldStatus: string,
    newStatus: string,
  ): Promise<void> {
    const resolved = await this.resolveBindingsForMonitor(monitorId, groupId);
    if (resolved.length === 0) return;

    const trigger: 'down' | 'up' = (
      newStatus === 'down' || newStatus === 'ssl_expired' || newStatus === 'ssl_warning' || newStatus === 'alert'
    ) ? 'down' : 'up';

    const ctx: TriggerContext = {
      monitorId, monitorName, monitorUrl, monitorType,
      oldStatus, newStatus, trigger,
      timestamp: new Date().toISOString(),
    };

    for (const binding of resolved) {
      // Filter by trigger_on
      const matchesTrigger =
        binding.triggerOn === 'both' ||
        binding.triggerOn === trigger;
      if (!matchesTrigger) continue;

      // Check cooldown
      if (binding.cooldownSeconds > 0) {
        const recent = await db('remediation_runs')
          .where({ action_id: binding.actionId, monitor_id: monitorId })
          .where('triggered_at', '>', new Date(Date.now() - binding.cooldownSeconds * 1000))
          .whereNot({ status: 'cooldown_skip' })
          .first();
        if (recent) {
          await db('remediation_runs').insert({
            action_id: binding.actionId,
            monitor_id: monitorId,
            triggered_by: trigger,
            status: 'cooldown_skip',
            triggered_at: new Date(),
          });
          logger.debug(`Remediation action ${binding.actionId} skipped (cooldown) for monitor ${monitorId}`);
          continue;
        }
      }

      // Execute async (don't block handleStatusChange)
      this._executeAction(binding.action, ctx).catch(err => {
        logger.error(err, `Unhandled error in remediation action ${binding.actionId}`);
      });
    }
  },

  async _executeAction(action: RemediationAction, ctx: TriggerContext): Promise<void> {
    const start = Date.now();
    let result: RunResult;

    try {
      if (isServerExecutedActionType(action.type) && !serverScriptsEnabled()) {
        // Checked at run time too, so it also covers actions brought in through Import
        result = { status: 'failed', error: SERVER_SCRIPTS_DISABLED_ERROR };
      } else {
        switch (action.type) {
          case 'webhook':
          case 'n8n':
            result = await this._execWebhook(action.config as WebhookRemediationConfig, ctx);
            break;
          case 'script':
            result = await this._execScript(action.config as ScriptRemediationConfig, ctx);
            break;
          case 'docker_restart':
            result = await this._execDockerRestart(action.config as DockerRestartRemediationConfig, ctx);
            break;
          case 'ssh':
            result = await this._execSsh(action.config as SshRemediationConfig, ctx);
            break;
          default:
            result = { status: 'failed', error: `Unknown action type: ${action.type}` };
        }
      }
    } catch (err) {
      result = {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const durationMs = Date.now() - start;

    await db('remediation_runs').insert({
      action_id:    action.id,
      monitor_id:   ctx.monitorId,
      triggered_by: ctx.trigger,
      status:       result.status,
      output:       result.output ?? null,
      error:        result.error  ?? null,
      duration_ms:  durationMs,
      triggered_at: new Date(),
    });

    // Audit (never the output: it may hold secrets). log() never throws.
    await auditService.log({
      tenantId: action.tenantId ?? null,
      userId: null,
      action: 'remediation.executed',
      resourceType: 'remediation_action',
      resourceId: action.id,
      details: {
        monitorId: ctx.monitorId,
        trigger: ctx.trigger,
        status: result.status,
        durationMs,
        ...(result.error ? { error: String(result.error).slice(0, 300) } : {}),
      },
    });

    logger.info(
      `Remediation action "${action.name}" (id:${action.id}) → ${result.status} in ${durationMs}ms for monitor ${ctx.monitorId}`,
    );
  },

  // ── Executors ─────────────────────────────────────────────────────────────────

  async _execWebhook(cfg: WebhookRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 10_000);

    const payload = {
      event: `monitor.${ctx.trigger}`,
      monitor: {
        id: ctx.monitorId,
        name: ctx.monitorName,
        url: ctx.monitorUrl,
        type: ctx.monitorType,
      },
      status: ctx.newStatus,
      previousStatus: ctx.oldStatus,
      triggeredAt: ctx.timestamp,
    };

    try {
      const res = await fetch(cfg.url, {
        method: cfg.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(cfg.headers ?? {}),
        },
        body: ['GET', 'HEAD'].includes(cfg.method ?? 'POST')
          ? undefined
          : JSON.stringify({ ...payload, ...(cfg.bodyExtra ?? {}) }),
        signal: controller.signal,
      });

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        return { status: 'failed', output: text, error: `HTTP ${res.status} ${res.statusText}` };
      }
      return { status: 'success', output: text.slice(0, 2000) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort') || msg.includes('timeout')) {
        return { status: 'timeout', error: msg };
      }
      return { status: 'failed', error: msg };
    } finally {
      clearTimeout(timer);
    }
  },

  async _execScript(cfg: ScriptRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    return new Promise((resolve) => {
      const timeoutMs = cfg.timeoutMs ?? 30_000;
      const shell     = cfg.shell ?? '/bin/sh';

      // Minimal environment: a few harmless server variables + the trigger context
      const env: NodeJS.ProcessEnv = {};
      for (const name of SCRIPT_ENV_ALLOWLIST) {
        const value = process.env[name];
        if (value !== undefined) env[name] = value;
      }
      Object.assign(env, {
        MONITOR_ID:     String(ctx.monitorId),
        MONITOR_NAME:   ctx.monitorName,
        MONITOR_URL:    ctx.monitorUrl ?? '',
        MONITOR_TYPE:   ctx.monitorType,
        STATUS:         ctx.newStatus,
        PREV_STATUS:    ctx.oldStatus,
        TRIGGERED_AT:   ctx.timestamp,
        TRIGGER:        ctx.trigger,
      });

      const child = exec(cfg.script, {
        shell,
        timeout: timeoutMs,
        env,
        maxBuffer: 512 * 1024,
      }, (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal === 'SIGTERM') {
            resolve({ status: 'timeout', output: stdout.slice(0, 2000), error: 'Script timed out' });
          } else {
            resolve({ status: 'failed', output: stdout.slice(0, 2000), error: stderr.slice(0, 500) || error.message });
          }
        } else {
          resolve({ status: 'success', output: (stdout + '\n' + stderr).trim().slice(0, 2000) });
        }
      });

      // Belt-and-suspenders kill if exec timeout doesn't fire
      const killer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs + 2000);
      child.once('exit', () => clearTimeout(killer));
    });
  },

  async _execDockerRestart(cfg: DockerRestartRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    const containerName = cfg.containerName;
    const socketPath    = cfg.socketPath ?? '/var/run/docker.sock';
    const path          = `/containers/${encodeURIComponent(containerName)}/restart`;

    return new Promise((resolve) => {
      const req = http.request(
        { socketPath, method: 'POST', path },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: 'success', output: `Container "${containerName}" restarted (HTTP ${res.statusCode})` });
            } else if (res.statusCode === 404) {
              resolve({ status: 'failed', error: `Container "${containerName}" not found` });
            } else {
              resolve({ status: 'failed', error: `Docker API returned HTTP ${res.statusCode}: ${body.slice(0, 200)}` });
            }
          });
        },
      );

      req.on('error', (err) => {
        resolve({ status: 'failed', error: err.message });
      });

      setTimeout(() => {
        req.destroy();
        resolve({ status: 'timeout', error: 'Docker API request timed out after 15s' });
      }, 15_000);

      req.end();
    });
  },

  async _execSsh(cfg: SshRemediationConfig, ctx: TriggerContext): Promise<RunResult> {
    // Fetch the real encrypted credential from DB (the API returns '[set]' masking)
    // We need to re-query the action from DB to get the unmasked config.
    // This is handled by the caller (_executeAction) which passes the DB config directly,
    // but since rowToAction masks it, we need to re-query without masking.
    let encryptedCred: string | undefined;
    // Pinned host key, read from the DB row as well (the current pin, not the one
    // captured when the bindings were resolved)
    let pinnedFingerprint: string | null = normalizeHostKeyFingerprint(
      (cfg as SshRemediationConfig & { hostKeySha256?: string }).hostKeySha256,
    );
    // Strict actions (created / edited / imported since host-key pinning) never
    // trust a key on first use. Unreadable row = strict.
    let hostKeyStrict = true;
    try {
      const raw = await db('remediation_actions')
        .where({ id: ctx._actionId })
        .select('config')
        .first() as { config: unknown } | undefined;
      if (raw) {
        const c = typeof raw.config === 'string' ? JSON.parse(raw.config) : raw.config as Record<string, unknown>;
        encryptedCred = c.credentialEnc as string | undefined;
        pinnedFingerprint = normalizeHostKeyFingerprint(c.hostKeySha256);
        hostKeyStrict = c.hostKeyStrict === true;
      }
    } catch (err) {
      logger.error(err, 'Failed to fetch SSH credential from DB');
    }

    if (!encryptedCred) {
      return { status: 'failed', error: 'No SSH credential configured' };
    }

    let credential: string;
    try {
      const decrypted = decryptCredentialWithLegacyFallback(encryptedCred);
      credential = decrypted.plaintext;
      if (decrypted.legacy && ctx._actionId) {
        // Stored under a legacy default secret: re-encrypt with the current key.
        try {
          await db('remediation_actions')
            .where({ id: ctx._actionId })
            .whereRaw(`jsonb_typeof(config) = 'object'`)
            .update({ config: db.raw(`config || jsonb_build_object('credentialEnc', ?::text)`, [encryptCredential(credential)]) });
          logger.warn({ actionId: ctx._actionId }, 'SSH credential was encrypted with a legacy default secret; re-encrypted with the current key');
        } catch (e) {
          logger.error(e, 'Failed to re-encrypt legacy SSH credential');
        }
      }
    } catch (err) {
      return { status: 'failed', error: 'Failed to decrypt SSH credential' };
    }

    const timeoutMs = cfg.timeoutMs ?? 15_000;
    const actionId  = ctx._actionId;

    return new Promise((resolve) => {
      const conn = new SshClient();
      let resolved = false;
      // Host-key check state (the verifier runs before any credential is sent)
      let presentedFingerprint: string | null = null;
      let hostKeyRejected = false;
      let pinnedOnFirstUse = false;
      const done = (r: RunResult) => {
        if (resolved) return;
        resolved = true;
        if (pinnedOnFirstUse && presentedFingerprint) {
          const note = `[host key ${presentedFingerprint} pinned on first use]`;
          r = { ...r, output: r.output ? `${note}\n${r.output}`.slice(0, 2000) : note };
        }
        resolve(r);
      };

      const timer = setTimeout(() => {
        conn.end();
        done({ status: 'timeout', error: `SSH command timed out after ${timeoutMs}ms` });
      }, timeoutMs);

      conn.on('ready', () => {
        // Inject context variables into the command via env vars prepended as shell assignments.
        // The monitor name is user-controlled and must never be evaluated by the remote shell
        // (whatever it is): values are single-quoted, MONITOR_NAME is further restricted to
        // shell-inert characters, and the exact name is available base64-encoded.
        const envPrefix = [
          `MONITOR_ID=${shellQuote(ctx.monitorId)}`,
          `MONITOR_NAME=${shellQuote(shellSafeChars(ctx.monitorName))}`,
          `MONITOR_NAME_B64=${shellQuote(Buffer.from(ctx.monitorName, 'utf8').toString('base64'))}`,
          `STATUS=${shellQuote(ctx.newStatus)}`,
          `PREV_STATUS=${shellQuote(ctx.oldStatus)}`,
          `TRIGGER=${shellQuote(ctx.trigger)}`,
        ].join(' ');
        const fullCmd = `${envPrefix} ${cfg.command}`;

        conn.exec(fullCmd, (err, stream) => {
          if (err) {
            clearTimeout(timer);
            conn.end();
            done({ status: 'failed', error: err.message });
            return;
          }

          let stdout = '';
          let stderr = '';
          stream.on('data', (d: Buffer) => { stdout += d.toString(); });
          stream.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
          stream.on('close', (code: number | null) => {
            clearTimeout(timer);
            conn.end();
            const output = (stdout + '\n' + stderr).trim().slice(0, 2000);
            if (code === 0 || code === null) {
              done({ status: 'success', output });
            } else {
              done({ status: 'failed', output, error: `Exit code ${code}` });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timer);
        if (hostKeyRejected) {
          done({
            status: 'failed',
            error: `${HOST_KEY_MISMATCH_ERROR}: the server presented ${presentedFingerprint ?? 'an unknown key'}, `
              + `pinned is ${pinnedFingerprint ?? 'none'}`,
          });
          return;
        }
        done({ status: 'failed', error: err.message });
      });

      const connectOptions: Parameters<SshClient['connect']>[0] = {
        host:     cfg.host,
        port:     cfg.port ?? 22,
        username: cfg.username,
        readyTimeout: timeoutMs,
        // Called with the raw host key during key exchange, before authentication:
        // returning false aborts the connection, so a host answering with another
        // key never receives the credential nor the command.
        hostVerifier: (key: Buffer): boolean => {
          const fingerprint = sshHostKeyFingerprint(key);
          presentedFingerprint = fingerprint;
          if (pinnedFingerprint) {
            if (fingerprint === pinnedFingerprint) return true;
            hostKeyRejected = true;
            return false;
          }
          // No pin. Strict actions fail closed. Only legacy actions (created
          // before host-key pinning, never edited since) trust on first use and
          // pin the key, so every later run is verified against it.
          if (actionId === undefined || hostKeyStrict) {
            hostKeyRejected = true;
            return false;
          }
          pinnedOnFirstUse = true;
          logger.warn(
            `SSH remediation action ${actionId}: no host key pinned for ${cfg.host}:${cfg.port ?? 22} — `
            + `trusting ${fingerprint} on first use and pinning it`,
          );
          pinHostKeyIfUnset(actionId, fingerprint).catch(err => {
            logger.error(err, `Failed to pin SSH host key for remediation action ${actionId}`);
          });
          return true;
        },
      };
      if (cfg.authType === 'password') {
        connectOptions.password = credential;
      } else {
        connectOptions.privateKey = credential;
      }
      conn.connect(connectOptions);
    });
  },
};

// ─── Trigger context ─────────────────────────────────────────────────────────

interface TriggerContext {
  monitorId:   number;
  monitorName: string;
  monitorUrl?: string;
  monitorType: string;
  oldStatus:   string;
  newStatus:   string;
  trigger:     'down' | 'up';
  timestamp:   string;
  /** Internal: action id for re-fetching unmasked SSH credential */
  _actionId?:  number;
}

// Patch _executeAction to inject _actionId into ctx before passing to _execSsh
const origExecAction = remediationService._executeAction.bind(remediationService);
remediationService._executeAction = async function (action: RemediationAction, ctx: TriggerContext) {
  return origExecAction(action, { ...ctx, _actionId: action.id });
};
