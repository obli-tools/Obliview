import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import type { MonitorStatus } from '@obliview/shared';
import { SETTINGS_KEYS, HARDCODED_DEFAULTS } from '@obliview/shared';
import { logger } from '../utils/logger';
import { agentService } from './agent.service';
import { db } from '../db';
import { settingsService } from './settings.service';
import { deviceIdentityService, type IdentityClaim } from './deviceIdentity.service';
import type { CheckResult } from '../workers/BaseMonitorWorker';

// ── Types ─────────────────────────────────────────────────────────────────────

interface AgentConn {
  ws: WebSocket;
  /** API key row ID — forwarded to agentService.handlePush */
  apiKeyId: number;
  tenantId: number;
  /** Current key of this connection in byDevice. Changes when the device is
   *  re-keyed to its shared Obli* ID (identity v2) — always read it from
   *  here, never from a value captured at registration. */
  deviceUuid: string;
  clientIp: string;
  /** The ?uuid= the agent dialled with (its current ID on its side). */
  legacyUuid: string;
  /** Identity v2 claim announced on the dial, not resolved yet (resolved by
   *  the first real heartbeat, which carries the hostname). */
  identity: IdentityClaim | null;
  /** Shared ID to acknowledge in the next config reply (`identityAck`). */
  identityAck: string | null;
}

interface AgentHeartbeat {
  type: 'heartbeat';
  hostname?: string;
  agentVersion?: string;
  deviceType?: 'agent' | 'proxy';
  agentBuild?: string;
  osInfo?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}

interface AgentAck {
  type: 'ack';
  id: string;
  commandType: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

interface AgentProxyResult {
  type: 'proxy_result';
  monitorId?: unknown;
  result?: unknown;
}

interface PendingAck {
  deviceUuid: string;
  /** Socket the command was sent on — only an ack from this socket resolves it. */
  ws: WebSocket;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Statuses a proxy check may report. The Go agent (agent/proxy_check.go) and
 * the Node proxy (proxy/src/checks) only emit 'up' / 'down'; the SSL statuses
 * are the other outcomes a regular check can produce. Server-side states
 * (pending, paused, maintenance, alert, inactive, updating) are never accepted.
 */
const PROXY_RESULT_STATUSES = new Set<string>(['up', 'down', 'ssl_warning', 'ssl_expired']);

/** Cap on proxy-supplied text stored in heartbeats and forwarded to notifications. */
const PROXY_RESULT_MAX_TEXT = 4096;

/** Largest value accepted for integer heartbeat columns (response_time, status_code). */
const PG_INT_MAX = 2_147_483_647;

/**
 * Timeout of a proxied check when no timeout setting exists anywhere in the
 * monitor's chain: proxy checks always used 10 s (not the 5 s hardcoded
 * default of the server-side workers).
 */
const PROXY_DEFAULT_TIMEOUT_MS = 10_000;

function nonNegativeNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function nonNegativeInt(v: unknown): number | undefined {
  const n = nonNegativeNumber(v);
  return n === undefined ? undefined : Math.min(Math.round(n), PG_INT_MAX);
}

function boundedText(v: unknown): string | undefined {
  return typeof v === 'string' ? v.slice(0, PROXY_RESULT_MAX_TEXT) : undefined;
}

/** JSONB column value as an object (legacy rows may hold JSON text); null when absent or invalid. */
function jsonObject(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

// ── Service ───────────────────────────────────────────────────────────────────

class AgentHubService {
  /** deviceUuid → active connection */
  private byDevice = new Map<string, AgentConn>();

  /** command id → pending ack promise */
  private pendingAcks = new Map<string, PendingAck>();

  constructor() {
    // Ping all connected agents every 15 s to keep connections alive through
    // reverse proxies that close idle connections.
    setInterval(() => {
      for (const [uuid, conn] of this.byDevice) {
        if (conn.ws.readyState === 1 /* OPEN */) {
          try { (conn.ws as any).ping(); } catch { this._unregister(uuid, conn.ws); }
        }
      }
    }, 15_000);
  }

  /**
   * Register an agent WebSocket command channel.
   * Replaces any previous connection for the same UUID cleanly.
   * Drains any pending_command stored in DB immediately on connect.
   */
  async register(
    apiKeyId: number,
    tenantId: number,
    deviceUuid: string,
    clientIp: string,
    ws: WebSocket,
    identity: IdentityClaim | null = null,
  ): Promise<void> {
    const conn: AgentConn = {
      ws, apiKeyId, tenantId, deviceUuid, clientIp, legacyUuid: deviceUuid, identity, identityAck: null,
    };

    // Handlers are attached before the ownership check so frames sent right
    // after the handshake are not lost; each handler is bound to the
    // connection's tenant / device / socket on its own (conn.deviceUuid is
    // read at call time: it follows an identity v2 re-key).
    // Frames are processed once the setup below is done (the agent's first
    // heartbeat is sent right after the handshake): the identity v2 claim and
    // the key the channel is filed under must be settled before it runs.
    let setupDone!: () => void;
    const ready = new Promise<void>((resolve) => { setupDone = resolve; });
    ws.on('close', () => this._unregister(conn.deviceUuid, ws));
    ws.on('error', () => this._unregister(conn.deviceUuid, ws));
    ws.on('message', async (data: Buffer) => {
      await ready;
      if (ws.readyState !== 1 /* OPEN */) return; // refused / closed during setup
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'heartbeat') {
          await this._handleHeartbeat(conn, msg as AgentHeartbeat);
        } else if (msg.type === 'ack') {
          this._handleAck(conn, msg as AgentAck);
        } else if (msg.type === 'proxy_result') {
          await this._handleProxyResult(conn, msg as AgentProxyResult);
        }
      } catch { /* malformed JSON — ignore */ }
    });

    try {
      await this._attach(conn, deviceUuid);
    } finally {
      setupDone();
    }
  }

  /** Ownership checks, identity v2 claim, filing in byDevice, config probe. */
  private async _attach(conn: AgentConn, dialUuid: string): Promise<void> {
    const { ws, apiKeyId, tenantId, identity } = conn;

    // Identity v2 (shared Obli* device ID): the agent
    // dials with its current (legacy) ID and announces the shared ID. When a
    // row is already keyed by the shared ID (switch completed by an earlier
    // session whose ack was lost, or by the HTTP push), the channel is filed
    // under it right away and the switch is acknowledged in the first config
    // reply. Otherwise the agent's first real heartbeat resolves the claim
    // (adoption needs its hostname). The legacy ID is never mapped through an
    // alias here: it may be shared with another machine.
    if (identity) {
      try {
        const ex = await deviceIdentityService.resolveExisting(identity.target, tenantId, apiKeyId);
        if (ex.verdict === 'use') {
          conn.deviceUuid = identity.target;
          conn.identityAck = identity.target;
          conn.identity = null;
        } else if (ex.verdict === 'refuse') {
          conn.identity = null; // v1 behaviour for this session
        }
      } catch (e) {
        logger.error(e, 'agentHub: identity v2 lookup failed — resolving on the first heartbeat');
      }
    }

    // Device UUIDs are globally unique: refuse a UUID already registered under
    // another tenant. Otherwise a key from tenant A could evict tenant B's live
    // channel and receive B's proxy monitor configs and commands.
    const owner = await db('agent_devices')
      .where({ uuid: conn.deviceUuid })
      .select('tenant_id')
      .first() as { tenant_id: number } | undefined;
    if (owner && owner.tenant_id !== tenantId) {
      // Tenant transfer: the agent still uses the key of its former workspace
      // and has not applied its 'reconfigure' yet — hand it the new key (only
      // to that former key, see agentService.getTransferReconfigure), then close.
      const reconfigure = await agentService.getTransferReconfigure(conn.deviceUuid, apiKeyId).catch(() => null);
      if (!reconfigure && conn.identity) {
        // Identity v2 pending: the legacy ID belongs to a machine of another
        // workspace (junk / cloned SMBIOS UUID). Park the channel under the
        // shared ID it announced (no row yet); its first heartbeat registers
        // it there. If the claim ends up ignored, the heartbeat falls back to
        // the legacy ID and gets the v1 refusal.
        logger.info({ legacyUuid: conn.deviceUuid, target: conn.identity.target, tenantId },
          'Obliview agent WS: legacy ID registered in another workspace — waiting for the identity v2 switch');
        conn.deviceUuid = conn.identity.target;
      } else {
        ws.removeAllListeners('message');
        if (reconfigure && ws.readyState === 1 /* OPEN */) {
          logger.info({ deviceUuid: conn.deviceUuid }, 'Obliview agent WS: delivering reconfigure after a tenant transfer');
          try {
            ws.send(JSON.stringify({ type: 'config', command: 'reconfigure', commandPayload: reconfigure }));
          } catch { /* closing below anyway */ }
        } else {
          logger.warn({ deviceUuid: conn.deviceUuid, tenantId }, 'Obliview agent WS rejected: device belongs to another tenant');
        }
        try { ws.close(4003, 'Device not found'); } catch {}
        return;
      }
    }
    // The socket may have dropped while the ownership check was running.
    if (ws.readyState !== 1 /* OPEN */) return;

    const existing = this.byDevice.get(conn.deviceUuid);
    if (existing && existing.ws.readyState === 1 /* OPEN */) {
      try { existing.ws.close(1000, 'replaced'); } catch {}
    }
    this.byDevice.set(conn.deviceUuid, conn);

    logger.info({ deviceUuid: conn.deviceUuid, legacyUuid: conn.deviceUuid !== dialUuid ? dialUuid : undefined },
      'Obliview agent WS connected');

    // Identity v2 claim still pending: no config probe and no proxy sync under
    // the legacy ID — it may be another machine's row (shared junk UUID). The
    // agent's first heartbeat, sent right after connecting, resolves the
    // claim, then gets its config and its proxy monitors.
    if (conn.identity) return;

    // Send an initial config response immediately so the agent gets its interval
    // and any queued command without waiting for the first timed heartbeat.
    // This empty frame is a "config probe" for handlePush: it never registers a
    // device, overwrites its metadata or records an empty metrics sample.
    await this._handleHeartbeat(conn, { type: 'heartbeat' });

    // Push proxy monitor configs to the agent so it can start checking immediately.
    const syncUuid = conn.deviceUuid;
    this.syncProxyMonitors(syncUuid).catch((e) =>
      logger.error(e, `Failed to sync proxy monitors on connect for ${syncUuid}`),
    );
  }

  /**
   * Identity v2: move a live connection to another key of byDevice (the
   * device row was re-keyed to the shared Obli* ID, or a pending claim fell
   * back to the legacy ID). A different open channel already filed under the
   * new key is replaced, like a reconnect.
   */
  private _rekeyConn(conn: AgentConn, newUuid: string): void {
    const oldUuid = conn.deviceUuid;
    if (oldUuid === newUuid) return;
    if (this.byDevice.get(oldUuid) === conn) this.byDevice.delete(oldUuid);
    const existing = this.byDevice.get(newUuid);
    if (existing && existing !== conn && existing.ws.readyState === 1 /* OPEN */) {
      try { existing.ws.close(1000, 'replaced'); } catch {}
    }
    conn.deviceUuid = newUuid;
    if (conn.ws.readyState === 1 /* OPEN */) this.byDevice.set(newUuid, conn);
    for (const pending of this.pendingAcks.values()) {
      if (pending.ws === conn.ws) pending.deviceUuid = newUuid;
    }
  }

  /**
   * Identity v2: a device row was re-keyed oldUuid -> newUuid outside of the
   * channel (HTTP push adoption). A channel still filed under oldUuid is
   * closed so the agent redials (under the new ID once it got the ack); it is
   * not moved: that channel may belong to another machine sharing the legacy
   * ID. `except` = the socket that presented the claim (already moved).
   */
  closeRekeyedChannel(oldUuid: string, except?: WebSocket): void {
    const conn = this.byDevice.get(oldUuid);
    if (!conn || conn.ws === except) return;
    try { conn.ws.close(1012, 'device identity changed'); } catch { /* already closing */ }
    this._unregister(oldUuid, conn.ws);
  }

  private _unregister(deviceUuid: string, ws: WebSocket): void {
    const existing = this.byDevice.get(deviceUuid);
    if (existing?.ws === ws) {
      this.byDevice.delete(deviceUuid);
      logger.info({ deviceUuid }, 'Obliview agent WS disconnected');

      // Reject all pending acks for this device so callers don't hang until timeout.
      for (const [id, pending] of this.pendingAcks) {
        if (pending.deviceUuid === deviceUuid) {
          clearTimeout(pending.timer);
          this.pendingAcks.delete(id);
          pending.reject(new Error(`Agent ${deviceUuid} disconnected`));
        }
      }
    }
  }

  private _handleAck(conn: AgentConn, msg: AgentAck): void {
    const pending = this.pendingAcks.get(msg.id);
    // Only the socket the command was sent on may resolve it.
    if (!pending || pending.ws !== conn.ws) return;
    this.pendingAcks.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.success) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(msg.error ?? 'Agent command failed'));
    }
  }

  private async _handleHeartbeat(conn: AgentConn, msg: AgentHeartbeat): Promise<void> {
    try {
      // Identity v2: the first real heartbeat (it carries the hostname the
      // adoption rule needs) resolves the claim announced on the dial —
      // adopt / register under the shared ID and acknowledge it, or ignore
      // the claim and carry on under the legacy ID exactly like a v1 agent.
      // The heartbeat is this agent's push: it never falls back to an alias.
      const isProbe = !msg.hostname && !msg.agentVersion;
      let identityResolved = false;
      if (conn.identity && !isProbe) {
        const claim = conn.identity;
        conn.identity = null;
        let ident;
        try {
          ident = await deviceIdentityService.resolvePush({
            tenantId: conn.tenantId,
            apiKeyId: conn.apiKeyId,
            legacyUuid: conn.legacyUuid,
            hostname: msg.hostname,
            claim,
          });
        } catch (e) {
          conn.identity = claim; // retried by the next heartbeat
          throw e;
        }
        identityResolved = true;
        if (ident.uuid) {
          if (ident.adoptedFrom) this.closeRekeyedChannel(ident.adoptedFrom, conn.ws);
          this._rekeyConn(conn, ident.uuid);
          conn.identityAck = ident.uuid;
        } else {
          this._rekeyConn(conn, conn.legacyUuid);
        }
      }

      const response = await agentService.handlePush(
        conn.apiKeyId,
        conn.tenantId,
        conn.deviceUuid,
        conn.clientIp,
        {
          hostname: msg.hostname ?? '',
          agentVersion: msg.agentVersion ?? '',
          deviceType: msg.deviceType,
          agentBuild: typeof msg.agentBuild === 'string' ? msg.agentBuild : undefined,
          osInfo: msg.osInfo as any,
          metrics: (msg.metrics ?? {}) as any,
        },
      );

      if (conn.ws.readyState !== 1 /* OPEN */) return;

      if (response.status === 'conflict') {
        // UUID registered in another workspace — same outcome as the ownership
        // check in register().
        try { conn.ws.close(4003, 'Device not found'); } catch {}
        return;
      }

      // Build config reply — same fields the old HTTP push endpoint returned.
      const configMsg: Record<string, unknown> = { type: 'config' };
      if (response.config?.checkIntervalSeconds) {
        configMsg.checkIntervalSeconds = response.config.checkIntervalSeconds;
      }
      // latestVersion goes to approved devices (status 'ok') only:
      //  - with autoUpdate:true for the legacy fleet-wide self-update
      //    (AGENT_LEGACY_AUTO_UPDATE=true) — current agents honour
      //    latestVersion only alongside that flag;
      //  - alongside an admin-paced 'update' command (= its targetVersion, no
      //    flag), so agents that predate the command still install it.
      if (response.status === 'ok' && response.latestVersion) {
        configMsg.latestVersion = response.latestVersion;
        if (response.autoUpdate) configMsg.autoUpdate = true;
      }
      if (response.command) {
        configMsg.command = response.command;
        if (response.commandPayload) configMsg.commandPayload = response.commandPayload;
      }
      // Identity v2: the device row is keyed by the shared ID — tell the
      // agent to switch (it then redials under the new ?uuid=). WS equivalent
      // of the push's X-Obli-Device-Id-Ack header.
      if (conn.identityAck) {
        configMsg.identityAck = conn.identityAck;
        conn.identityAck = null;
      }

      conn.ws.send(JSON.stringify(configMsg));

      if (identityResolved) {
        // Proxy monitors were not synced at connect while the claim was
        // pending: sync them now under the key the channel ended up on.
        const syncUuid = conn.deviceUuid;
        this.syncProxyMonitors(syncUuid).catch((e) =>
          logger.error(e, `Failed to sync proxy monitors after identity resolution for ${syncUuid}`),
        );
      }
    } catch (e) {
      logger.error(e, 'agentHub: failed to handle heartbeat');
    }
  }

  // ── Proxy result handling ────────────────────────────────────────────────

  private async _handleProxyResult(conn: AgentConn, msg: AgentProxyResult): Promise<void> {
    const { monitorId } = msg;
    const raw = msg.result as Record<string, unknown> | null | undefined;
    if (typeof monitorId !== 'number' || !Number.isInteger(monitorId) || monitorId <= 0) return;
    if (!raw || typeof raw !== 'object' || typeof raw.status !== 'string' || !PROXY_RESULT_STATUSES.has(raw.status)) {
      logger.debug({ deviceUuid: conn.deviceUuid, monitorId }, 'agentHub: dropped malformed proxy result');
      return;
    }

    // Accept the result only for an active monitor of this connection's tenant
    // that is assigned to this very device as its proxy, and only while the
    // device is approved. Checked on every result so that refusing/suspending
    // the device or re-assigning the monitor takes effect immediately.
    let monitor: { type: string } | undefined;
    try {
      monitor = await db('monitors as m')
        .join('agent_devices as d', 'd.id', 'm.proxy_agent_device_id')
        .where({
          'm.id': monitorId,
          'm.tenant_id': conn.tenantId,
          'm.is_active': true,
          'd.uuid': conn.deviceUuid,
          'd.tenant_id': conn.tenantId,
          'd.status': 'approved',
        })
        .select('m.type')
        .first() as { type: string } | undefined;
    } catch (e) {
      logger.error(e, 'agentHub: failed to authorize proxy result');
      return;
    }
    if (!monitor) {
      logger.debug({ deviceUuid: conn.deviceUuid, monitorId }, 'agentHub: dropped proxy result for monitor not bound to this device');
      return;
    }

    // Rebuild the result from the fields the proxy producers actually send.
    // Server-side flags (suppressNotification, heartbeatStatus) are never taken
    // from the agent; valueChanged is only meaningful for value watchers.
    const result: CheckResult = {
      status: raw.status as MonitorStatus,
      responseTime: nonNegativeInt(raw.responseTime),
      statusCode: nonNegativeInt(raw.statusCode),
      message: boundedText(raw.message),
      ping: nonNegativeNumber(raw.ping),
      value: boundedText(raw.value),
    };
    if (raw.valueChanged === true && monitor.type === 'value_watcher') {
      result.valueChanged = true;
    }

    // Lazy import to avoid circular dependency at module load time.
    const { BaseMonitorWorker } = require('../workers/BaseMonitorWorker');
    BaseMonitorWorker.recordProxyResult(monitorId, result);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  isConnected(deviceUuid: string): boolean {
    const conn = this.byDevice.get(deviceUuid);
    return !!conn && conn.ws.readyState === 1;
  }

  connectedCount(): number {
    return this.byDevice.size;
  }

  /**
   * Close the command channels of the given devices (e.g. their tenant is
   * being deleted). Pending acks are rejected by the close handler. Returns
   * the number of channels closed. The agents' reconnection is refused once
   * their API key / device rows are gone.
   */
  disconnectDevices(deviceUuids: string[]): number {
    let closed = 0;
    for (const uuid of new Set(deviceUuids)) {
      const conn = this.byDevice.get(uuid);
      if (!conn) continue;
      try { conn.ws.close(4003, 'Device not found'); } catch { /* already closing */ }
      this._unregister(uuid, conn.ws);
      closed++;
    }
    if (closed > 0) logger.info({ closed }, 'Obliview agent WS channels closed');
    return closed;
  }

  /**
   * Push a config frame to a connected agent without processing a heartbeat —
   * e.g. right after approval, so the agent leaves its slow pending interval
   * immediately (the Go agent resets its heartbeat timer on a new interval).
   * Returns false when the device has no open command channel.
   */
  pushConfig(deviceUuid: string, config: { checkIntervalSeconds?: number }): boolean {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) return false;
    const msg: Record<string, unknown> = { type: 'config' };
    if (config.checkIntervalSeconds) msg.checkIntervalSeconds = config.checkIntervalSeconds;
    try {
      conn.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Deliver a one-shot command (AgentCommand: 'uninstall' | 'update' |
   * 'reconfigure') to a connected agent right away, in the same `config`
   * frame shape a heartbeat reply uses ({ command, commandPayload }).
   * Returns false when the device has no open command channel or the write
   * failed — the caller then keeps the command queued for the next push.
   */
  pushCommand(deviceUuid: string, command: string, payload?: Record<string, unknown>): boolean {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) return false;
    const msg: Record<string, unknown> = { type: 'config', command };
    if (payload) msg.commandPayload = payload;
    // Agents that predate the 'update' command act on latestVersion alone.
    if (command === 'update' && typeof payload?.targetVersion === 'string') {
      msg.latestVersion = payload.targetVersion;
    }
    try {
      conn.ws.send(JSON.stringify(msg));
      logger.info({ deviceUuid, command }, 'Obliview agent WS: command delivered');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a structured command to a connected agent and wait for its ack.
   * Returns the ack `result` field, or throws on timeout / agent error / disconnect.
   */
  async sendCommandAndWait(
    deviceUuid: string,
    commandType: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<unknown> {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1) {
      throw new Error(`Agent ${deviceUuid} is not connected`);
    }

    const id = crypto.randomUUID();
    const msg = JSON.stringify({ type: 'command', id, commandType, payload });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(id);
        reject(new Error(`Timeout waiting for ack from agent ${deviceUuid}`));
      }, timeoutMs);

      this.pendingAcks.set(id, { deviceUuid, ws: conn.ws, resolve, reject, timer });
      conn.ws.send(msg);
    });
  }

  /**
   * Send the list of proxy monitor configs to a specific agent.
   * Called on agent connect and when a proxy monitor is created/updated/deleted.
   */
  async syncProxyMonitors(deviceUuid: string): Promise<void> {
    const conn = this.byDevice.get(deviceUuid);
    if (!conn || conn.ws.readyState !== 1) return;

    // Find the agent_device row for this UUID within the connection's tenant —
    // never hand a device's configs to a connection authenticated for another tenant.
    const device = await db('agent_devices')
      .where({ uuid: deviceUuid, tenant_id: conn.tenantId })
      .select('id', 'tenant_id')
      .first() as { id: number; tenant_id: number } | undefined;
    if (!device) return;

    // Fetch all active monitors that use this device as proxy — scoped to the
    // device's tenant as defence-in-depth against cross-tenant config leaks.
    // The service layer already blocks cross-tenant assignment on create/update,
    // but this additional filter prevents any legacy rows or bypass from
    // leaking a tenant's monitor configuration to another tenant's proxy.
    // The list deliberately does not depend on the device status: nothing
    // re-syncs on approve/suspend/reinstate, so an empty list sent while
    // suspended would leave the agent idle after reinstatement. Results from a
    // non-approved device are dropped in _handleProxyResult instead.
    const monitors = await db('monitors')
      .where({ proxy_agent_device_id: device.id, is_active: true, tenant_id: device.tenant_id })
      // A paused monitor only has status 'paused': stop running it remotely too.
      .whereNot('status', 'paused')
      .select(
        'id', 'type', 'group_id',
        'url', 'method', 'headers', 'body', 'expected_status_codes',
        'keyword', 'keyword_is_present', 'ignore_ssl',
        'json_path', 'json_expected_value',
        'hostname', 'port',
        'dns_record_type', 'dns_resolver', 'dns_expected_value',
        'ssl_warn_days',
        'smtp_host', 'smtp_port',
        'game_type', 'game_host', 'game_port',
        'docker_host', 'docker_container_name',
        'script_command', 'script_expected_exit',
        'browser_url', 'browser_keyword', 'browser_keyword_is_present', 'browser_wait_for_selector',
        'value_watcher_url', 'value_watcher_json_path', 'value_watcher_operator',
        'value_watcher_threshold', 'value_watcher_threshold_max',
        'value_watcher_previous_value', 'value_watcher_headers',
      );

    // Field names match ProxyMonitorConfig (proxy/src/types.ts) read by
    // proxy/src/checks/* and the Go agent's proxy check (unknown fields ignored).
    // Timing comes from the settings table (monitor → group chain → workspace
    // → default), like MonitorWorkerManager.buildConfig — the legacy
    // interval_seconds / timeout_ms columns are no longer read (migration 061).
    // Resolved for all of this device's monitors in one query per key.
    const ids = monitors.map((m: Record<string, unknown>) => m.id as number);
    const [intervals, timeouts] = await Promise.all([
      settingsService.resolveKeyForTenantMonitors(device.tenant_id, SETTINGS_KEYS.CHECK_INTERVAL, ids),
      settingsService.resolveKeyForTenantMonitors(device.tenant_id, SETTINGS_KEYS.TIMEOUT, ids),
    ]);
    const intervalById = new Map(intervals.map((r) => [r.monitorId, r.value]));
    // Proxy checks have always run with a 10 s timeout when nothing set one:
    // keep it when the chain has no timeout row at all (hardcoded default),
    // explicit monitor / group / workspace values are honoured as they are.
    const timeoutById = new Map(timeouts.map((r) => [
      r.monitorId,
      r.source === 'default' ? Math.max(r.value, PROXY_DEFAULT_TIMEOUT_MS) : r.value,
    ]));

    const configs = monitors.map((m: Record<string, unknown>) => ({
      monitorId: m.id,
      type: m.type,
      intervalSeconds: intervalById.get(m.id as number) ?? HARDCODED_DEFAULTS[SETTINGS_KEYS.CHECK_INTERVAL],
      timeoutMs: timeoutById.get(m.id as number) ?? PROXY_DEFAULT_TIMEOUT_MS,
      url: m.url, method: m.method, headers: jsonObject(m.headers), body: m.body,
      expectedStatusCodes: m.expected_status_codes,
      keyword: m.keyword, keywordIsPresent: m.keyword_is_present,
      ignoreSsl: m.ignore_ssl,
      jsonPath: m.json_path, jsonExpectedValue: m.json_expected_value,
      hostname: m.hostname, port: m.port,
      dnsRecordType: m.dns_record_type, dnsResolver: m.dns_resolver, dnsExpectedValue: m.dns_expected_value,
      sslWarnDays: m.ssl_warn_days,
      smtpHost: m.smtp_host, smtpPort: m.smtp_port,
      gameType: m.game_type, gameHost: m.game_host, gamePort: m.game_port,
      // Docker
      dockerHost: m.docker_host, dockerContainerName: m.docker_container_name,
      // Script
      scriptCommand: m.script_command, scriptExpectedExit: m.script_expected_exit,
      // Browser (Playwright)
      browserUrl: m.browser_url, browserKeyword: m.browser_keyword,
      browserKeywordIsPresent: m.browser_keyword_is_present,
      browserWaitForSelector: m.browser_wait_for_selector,
      // Value Watcher
      valueWatcherUrl: m.value_watcher_url, valueWatcherJsonPath: m.value_watcher_json_path,
      valueWatcherOperator: m.value_watcher_operator,
      valueWatcherThreshold: m.value_watcher_threshold,
      valueWatcherThresholdMax: m.value_watcher_threshold_max,
      valueWatcherPreviousValue: m.value_watcher_previous_value,
      valueWatcherHeaders: jsonObject(m.value_watcher_headers),
    }));

    conn.ws.send(JSON.stringify({ type: 'proxy_sync', monitors: configs }));
    logger.info({ deviceUuid, count: configs.length }, 'Synced proxy monitors to agent');
  }

  /**
   * Sync proxy monitors to ALL connected agents.
   * Called when a proxy monitor is created, updated, or deleted.
   */
  async syncAllProxyMonitors(): Promise<void> {
    for (const [uuid] of this.byDevice) {
      await this.syncProxyMonitors(uuid).catch((e) =>
        logger.error(e, `Failed to sync proxy monitors to ${uuid}`),
      );
    }
  }
}

export const agentHub = new AgentHubService();
