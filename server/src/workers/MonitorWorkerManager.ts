import type { Server as SocketIOServer } from 'socket.io';
import type { Monitor } from '@obliview/shared';
import { SETTINGS_KEYS } from '@obliview/shared';
import { BaseMonitorWorker, type MonitorConfig } from './BaseMonitorWorker';
import { HttpMonitorWorker } from './HttpMonitorWorker';
import { PingMonitorWorker } from './PingMonitorWorker';
import { TcpMonitorWorker } from './TcpMonitorWorker';
import { DnsMonitorWorker } from './DnsMonitorWorker';
import { SslMonitorWorker } from './SslMonitorWorker';
import { SmtpMonitorWorker } from './SmtpMonitorWorker';
import { DockerMonitorWorker } from './DockerMonitorWorker';
import { GameServerMonitorWorker } from './GameServerMonitorWorker';
import { PushMonitorWorker } from './PushMonitorWorker';
import { ScriptMonitorWorker } from './ScriptMonitorWorker';
import { JsonApiMonitorWorker } from './JsonApiMonitorWorker';
import { BrowserMonitorWorker } from './BrowserMonitorWorker';
import { ValueWatcherMonitorWorker } from './ValueWatcherMonitorWorker';
import { AgentMonitorWorker } from './AgentMonitorWorker';
import { db } from '../db';
import { monitorService } from '../services/monitor.service';
import { settingsService } from '../services/settings.service';
import { groupNotificationService } from '../services/groupNotification.service';
import { logger } from '../utils/logger';

type WorkerConstructor = new (config: MonitorConfig, io: SocketIOServer) => BaseMonitorWorker;

const WORKER_REGISTRY: Record<string, WorkerConstructor> = {
  http: HttpMonitorWorker,
  ping: PingMonitorWorker,
  tcp: TcpMonitorWorker,
  dns: DnsMonitorWorker,
  ssl: SslMonitorWorker,
  smtp: SmtpMonitorWorker,
  docker: DockerMonitorWorker,
  game_server: GameServerMonitorWorker,
  push: PushMonitorWorker,
  script: ScriptMonitorWorker,
  json_api: JsonApiMonitorWorker,
  browser: BrowserMonitorWorker,
  value_watcher: ValueWatcherMonitorWorker,
  agent: AgentMonitorWorker,
};

export class MonitorWorkerManager {
  private static instance: MonitorWorkerManager;
  private workers: Map<number, BaseMonitorWorker> = new Map();
  /**
   * Starts in flight (between the has() check and workers.set(), across the
   * buildConfig await). Two concurrent startMonitor calls for the same id would
   * otherwise both create a worker, and the orphan would double-notify.
   * stopMonitor() removes the token, which cancels the pending start.
   */
  private starting: Map<number, symbol> = new Map();
  private io: SocketIOServer;

  private constructor(io: SocketIOServer) {
    this.io = io;
  }

  static getInstance(io?: SocketIOServer): MonitorWorkerManager {
    if (!MonitorWorkerManager.instance) {
      if (!io) throw new Error('SocketIOServer required for first initialization');
      MonitorWorkerManager.instance = new MonitorWorkerManager(io);
    }
    return MonitorWorkerManager.instance;
  }

  async startAll(): Promise<void> {
    const monitors = await monitorService.getAllActive();
    let started = 0;

    for (const monitor of monitors) {
      try {
        await this.startMonitor(monitor);
        started++;
      } catch (error) {
        logger.error(error, `Failed to start worker for monitor "${monitor.name}" (id: ${monitor.id})`);
      }
    }

    logger.info(`Started ${started}/${monitors.length} monitor workers`);

    // Initialize grouped notification state from DB
    try {
      await groupNotificationService.initialize();
    } catch (error) {
      logger.error(error, 'Failed to initialize group notification service');
    }
  }

  async stopAll(): Promise<void> {
    for (const [, worker] of this.workers) {
      worker.stop();
    }
    this.workers.clear();
    this.starting.clear();
    logger.info('All monitor workers stopped');
  }

  async startMonitor(monitor: Monitor): Promise<void> {
    if (this.workers.has(monitor.id) || this.starting.has(monitor.id)) {
      return;
    }

    const WorkerClass = WORKER_REGISTRY[monitor.type];
    if (!WorkerClass) {
      logger.warn(`No worker implementation for monitor type "${monitor.type}" (monitor: ${monitor.name})`);
      return;
    }

    const token = Symbol(`start:${monitor.id}`);
    this.starting.set(monitor.id, token);
    let config: MonitorConfig;
    try {
      config = await this.buildConfig(monitor);
    } catch (err) {
      if (this.starting.get(monitor.id) === token) this.starting.delete(monitor.id);
      throw err;
    }
    // Stopped (or restarted) while the config was being built: drop this start.
    if (this.starting.get(monitor.id) !== token) return;
    this.starting.delete(monitor.id);
    if (this.workers.has(monitor.id)) return;

    const worker = new WorkerClass(config, this.io);
    this.workers.set(monitor.id, worker);
    await worker.start();
  }

  async stopMonitor(monitorId: number): Promise<void> {
    this.starting.delete(monitorId);
    const worker = this.workers.get(monitorId);
    if (worker) {
      worker.stop();
      this.workers.delete(monitorId);
    }
  }

  async restartMonitor(monitorId: number): Promise<void> {
    await this.stopMonitor(monitorId);
    const monitor = await monitorService.getById(monitorId);
    if (monitor && monitor.isActive && monitor.status !== 'paused') {
      await this.startMonitor(monitor);
    }
  }

  async restartMonitors(monitorIds: number[]): Promise<void> {
    for (const id of monitorIds) {
      await this.restartMonitor(id);
    }
  }

  /**
   * Restart all running workers whose effective settings may have changed
   * because a settings row was added, modified, or removed at the given scope.
   *
   * - 'global' + tenantId: every running worker of that tenant (global settings
   *   are workspace defaults since migration 058). Without a tenantId every
   *   running worker is restarted (legacy behaviour).
   * - 'group' + scopeId: workers for monitors in this group or any descendant group.
   * - 'monitor' + scopeId: only that specific worker.
   */
  async restartAffectedBySettings(
    scope: 'monitor' | 'group' | 'global',
    scopeId: number | null,
    tenantId?: number | null,
  ): Promise<void> {
    let monitorIds: number[];

    if (scope === 'monitor' && scopeId !== null) {
      monitorIds = [scopeId];
    } else if (scope === 'group' && scopeId !== null) {
      // Include this group and all descendant groups (closure table).
      const descendants = await db('group_closure')
        .where('ancestor_id', scopeId)
        .select('descendant_id') as { descendant_id: number }[];
      const groupIds = descendants.map(r => r.descendant_id);
      const rows = await db('monitors')
        .whereIn('group_id', groupIds)
        .select('id') as { id: number }[];
      monitorIds = rows.map(r => r.id);
    } else if (tenantId !== undefined && tenantId !== null) {
      // Global (workspace) scope: only the running workers of this tenant.
      const running = [...this.workers.keys()];
      if (running.length === 0) return;
      const rows = await db('monitors')
        .where({ tenant_id: tenantId })
        .whereIn('id', running)
        .select('id') as { id: number }[];
      monitorIds = rows.map(r => r.id);
    } else {
      // Global without a tenant: restart every currently-running worker.
      monitorIds = [...this.workers.keys()];
    }

    // Only restart monitors that are actively running; others will pick up
    // fresh settings the next time startMonitor() is called.
    const toRestart = monitorIds.filter(id => this.workers.has(id));
    if (toRestart.length > 0) {
      const tenantSuffix = tenantId ? ` (tenant ${tenantId})` : '';
      logger.info(`Restarting ${toRestart.length} worker(s) due to ${scope} settings change${tenantSuffix}`);
      await this.restartMonitors(toRestart);
    }
  }

  isRunning(monitorId: number): boolean {
    return this.workers.has(monitorId);
  }

  getRunningCount(): number {
    return this.workers.size;
  }

  private async buildConfig(monitor: Monitor): Promise<MonitorConfig> {
    // Resolve settings through inheritance chain, with the monitor's own tenant
    // (global settings are per-workspace since migration 058).
    let tenantId = (monitor as Monitor & { tenantId?: number }).tenantId;
    if (tenantId === undefined) {
      const tenantRow = await db('monitors').where({ id: monitor.id }).select('tenant_id').first() as
        { tenant_id: number } | undefined;
      tenantId = tenantRow?.tenant_id;
    }
    const resolved = await settingsService.resolveForMonitor(monitor.id, monitor.groupId, tenantId);

    return {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      groupId: monitor.groupId,
      // Timing comes from the settings table only (monitor override → group
      // chain → workspace → hardcoded default). The legacy monitors columns
      // (interval_seconds, timeout_ms, retry_interval_seconds, max_retries)
      // were migrated into monitor-scope rows by migration 061 and are no
      // longer read.
      intervalSeconds: resolved[SETTINGS_KEYS.CHECK_INTERVAL].value,
      retryIntervalSeconds: resolved[SETTINGS_KEYS.RETRY_INTERVAL].value,
      maxRetries: resolved[SETTINGS_KEYS.MAX_RETRIES].value,
      timeoutMs: resolved[SETTINGS_KEYS.TIMEOUT].value,
      notificationCooldownSeconds: resolved[SETTINGS_KEYS.NOTIFICATION_COOLDOWN].value,
      upsideDown: monitor.upsideDown,
      // Pass all monitor properties for type-specific workers
      url: monitor.url,
      method: monitor.method,
      headers: monitor.headers,
      body: monitor.body,
      expectedStatusCodes: monitor.expectedStatusCodes,
      keyword: monitor.keyword,
      keywordIsPresent: monitor.keywordIsPresent,
      ignoreSsl: monitor.ignoreSsl,
      jsonPath: monitor.jsonPath,
      jsonExpectedValue: monitor.jsonExpectedValue,
      hostname: monitor.hostname,
      port: monitor.port,
      dnsRecordType: monitor.dnsRecordType,
      dnsResolver: monitor.dnsResolver,
      dnsExpectedValue: monitor.dnsExpectedValue,
      sslWarnDays: monitor.sslWarnDays,
      smtpHost: monitor.smtpHost,
      smtpPort: monitor.smtpPort,
      dockerHost: monitor.dockerHost,
      dockerContainerName: monitor.dockerContainerName,
      gameType: monitor.gameType,
      gameHost: monitor.gameHost,
      gamePort: monitor.gamePort,
      pushToken: monitor.pushToken,
      pushMaxIntervalSec: monitor.pushMaxIntervalSec,
      scriptCommand: monitor.scriptCommand,
      scriptExpectedExit: monitor.scriptExpectedExit,
      // Browser (Playwright)
      browserUrl: monitor.browserUrl,
      browserKeyword: monitor.browserKeyword,
      browserKeywordIsPresent: monitor.browserKeywordIsPresent,
      browserWaitForSelector: monitor.browserWaitForSelector,
      browserScreenshotOnFailure: monitor.browserScreenshotOnFailure,
      // Value Watcher
      valueWatcherUrl: monitor.valueWatcherUrl,
      valueWatcherJsonPath: monitor.valueWatcherJsonPath,
      valueWatcherOperator: monitor.valueWatcherOperator,
      valueWatcherThreshold: monitor.valueWatcherThreshold,
      valueWatcherThresholdMax: monitor.valueWatcherThresholdMax,
      valueWatcherPreviousValue: monitor.valueWatcherPreviousValue,
      valueWatcherHeaders: monitor.valueWatcherHeaders,
      // Agent Monitor
      agentDeviceId: monitor.agentDeviceId,
      agentThresholds: monitor.agentThresholds,
      // Proxy Agent
      proxyAgentDeviceId: monitor.proxyAgentDeviceId,
    };
  }
}
