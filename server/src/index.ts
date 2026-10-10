import './env';
import http from 'http';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { db } from './db';
import { config } from './config';
import { logger } from './utils/logger';
import { authService } from './services/auth.service';
import { obligateService } from './services/obligate.service';
import { MonitorWorkerManager } from './workers/MonitorWorkerManager';
import { retentionService } from './services/retention.service';
import { setAgentServiceIO, agentService } from './services/agent.service';
import { maintenanceService } from './services/maintenance.service';
import { setLiveAlertIO, liveAlertService } from './services/liveAlert.service';
import { agentHub } from './services/agentHub.service';
import { deviceIdentityService } from './services/deviceIdentity.service';
import { agentUpdateRollout, UPDATE_ROLLOUT_TICK_MS, isLegacyAutoUpdate } from './services/agentUpdateRollout.service';
import { lookupAgentKey } from './middleware/agentAuth';

// ── Process-level safety net ─────────────────────────────────────────────────
// On Node >= 15 an unhandled promise rejection exits the process: one missed
// `.catch()` in a worker or an async Express handler would stop every monitor.
// Log it and keep running. Same for uncaught exceptions: they are logged and
// the process stays up (the failing request/timer is lost, the rest goes on).
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'unhandledRejection');
});
process.on('uncaughtException', (err, origin) => {
  logger.error({ err, origin }, 'uncaughtException');
});

async function main() {
  // 1. Run pending migrations
  logger.info('Running database migrations...');
  await db.migrate.latest();
  logger.info('Migrations complete');

  // 2. Ensure default admin user exists
  await authService.ensureDefaultAdmin(
    config.defaultAdminUsername,
    config.defaultAdminPassword,
  );

  // 3. Create Express app
  const app = createApp();

  // 4. Create HTTP server
  const server = http.createServer(app);

  // 5. Attach Socket.io
  const io = createSocketServer(server);

  // Store io instance for later use
  app.set('io', io);

  // Provide io to agent service for real-time push events
  setAgentServiceIO(io);
  // Provide io to live alert service for real-time notification delivery
  setLiveAlertIO(io);

  // ── Agent WebSocket command channel ───────────────────────────────────────
  // Intercept 'upgrade' events so the agent WS endpoint shares the same HTTP
  // port as the REST API. All other upgrades are forwarded to socket.io.
  const agentWss = new WebSocketServer({ noServer: true });

  const sioUpgradeListeners = server.rawListeners('upgrade').slice();
  server.removeAllListeners('upgrade');

  const AGENT_WS_RE = /^\/api\/agent\/ws$/;

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;

    if (AGENT_WS_RE.test(pathname)) {
      const apiKey  = request.headers['x-api-key'] as string | undefined;
      const reqUrl  = new URL(request.url ?? '/', 'http://localhost');
      const devUuid = reqUrl.searchParams.get('uuid');

      agentWss.handleUpgrade(request, socket, head, async (ws: WebSocket) => {
        try {
          if (!apiKey)  { ws.close(4003, 'Missing X-Api-Key'); return; }
          if (!devUuid) { ws.close(4000, 'Missing uuid query param'); return; }

          // UUID-format check + 60 s cache (a non-UUID key would make
          // Postgres raise 22P02 on the uuid column).
          const key = await lookupAgentKey(apiKey);
          if (!key) { ws.close(4003, 'Invalid API key'); return; }

          const clientIp =
            (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ??
            (socket as any).remoteAddress ??
            '';

          // Identity v2: an agent switching to the shared Obli* device ID
          // dials with its current ID (?uuid=) and announces the target
          // (X-Obli-Device-Id / X-Obli-Previous-Ids); the hub resolves it
          // and acknowledges in a config reply (agentHub.register).
          const identity = deviceIdentityService.parseHeaders(request);
          await agentHub.register(key.id, key.tenantId, devUuid, clientIp, ws, identity);
        } catch (err) {
          logger.error(err, 'Obliview agent WS setup error');
          ws.close(4000, 'Internal error');
        }
      });
      return; // handled — do NOT forward to socket.io
    }

    // Forward everything else to socket.io's original upgrade listeners
    for (const listener of sioUpgradeListeners) {
      (listener as (...args: unknown[]) => void).call(server, request, socket, head);
    }
  });
  // ──────────────────────────────────────────────────────────────────────────

  // Start maintenance background jobs (cleanup + transition notifications)
  maintenanceService.startJobs();

  // 6. Start monitor workers
  const workerManager = MonitorWorkerManager.getInstance(io);
  await workerManager.startAll();

  // 7. Listen
  // A listen failure (EADDRINUSE...) must still stop the process: without this
  // listener it would surface as an uncaughtException, which is now only
  // logged, and leave a zombie instance running workers without HTTP.
  server.on('error', (err) => {
    logger.fatal(err, 'HTTP server error');
    process.exit(1);
  });
  server.listen(config.port, () => {
    logger.info(`Obliview server listening on port ${config.port}`);
    logger.info(`Environment: ${config.nodeEnv}`);
    logger.info(`Active monitors: ${workerManager.getRunningCount()}`);
    // Announce our accent color to Obligate (best-effort, off the boot path).
    void obligateService.announceSelfInfo();
  });

  // 8. Retention jobs (every 6 hours).
  //    - small tables (resolved live alerts, notification_log, expired password
  //      reset tokens): once at boot, then every 6 h;
  //    - heartbeats + remediation_runs (batched deletes, can be long on a big
  //      table): once 60 s after boot (off the boot path), then every 6 h.
  //      Heartbeats follow the heartbeat_retention_days setting resolved per
  //      monitor (retention.service.ts); remediation runs are kept as long as
  //      the longest effective retention.
  const LIVE_ALERT_RETENTION_DAYS = 30;
  const NOTIFICATION_LOG_RETENTION_DAYS = 30;
  const RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const HEARTBEAT_RETENTION_BOOT_DELAY_MS = 60 * 1000;

  const purgeAuxTables = async (): Promise<void> => {
    try {
      const deleted = await liveAlertService.cleanup(LIVE_ALERT_RETENTION_DAYS);
      if (deleted > 0) {
        logger.info(`Retention: purged ${deleted} resolved/legacy-read live alerts older than ${LIVE_ALERT_RETENTION_DAYS} days`);
      }
    } catch (err) {
      logger.error(err, 'Retention: live alert cleanup failed');
    }
    try {
      const cutoff = new Date(Date.now() - NOTIFICATION_LOG_RETENTION_DAYS * 86_400_000);
      const result = await db.raw(
        `DELETE FROM notification_log WHERE created_at < ?`,
        [cutoff],
      ) as { rowCount?: number };
      if ((result.rowCount ?? 0) > 0) {
        logger.info(`Retention: purged ${result.rowCount} notification_log rows older than ${NOTIFICATION_LOG_RETENTION_DAYS} days`);
      }
    } catch (err) {
      logger.error(err, 'Retention: notification_log purge failed');
    }
    try {
      const result = await db.raw(
        `DELETE FROM password_reset_tokens WHERE expires_at < NOW()`,
      ) as { rowCount?: number };
      if ((result.rowCount ?? 0) > 0) {
        logger.info(`Retention: purged ${result.rowCount} expired password reset tokens`);
      }
    } catch (err) {
      logger.error(err, 'Retention: password reset token purge failed');
    }
  };

  // runPurge() skips a call made while a previous batched run is still going.
  const purgeHeartbeats = async (): Promise<void> => {
    try {
      const result = await retentionService.runPurge();
      if (result && result.heartbeats > 0) {
        logger.info(`Retention: purged ${result.heartbeats} heartbeats in total`);
      }
    } catch (err) {
      logger.error(err, 'Retention: heartbeat purge failed');
    }
  };

  void purgeAuxTables();
  const retentionBootTimer = setTimeout(() => { void purgeHeartbeats(); }, HEARTBEAT_RETENTION_BOOT_DELAY_MS);
  const retentionTimer = setInterval(() => {
    void purgeAuxTables();
    void purgeHeartbeats();
  }, RETENTION_INTERVAL_MS);

  // 9. Agent lifecycle jobs.
  //    - expire uninstalls: auto-delete devices whose uninstall command was
  //      delivered more than 10 minutes ago (they have had enough time to
  //      uninstall and stop pushing) — every minute;
  //    - stuck updates: an update not completed within 10 minutes becomes
  //      update_error — every 5 minutes;
  //    - update rollout tick: hands queued agent updates to connected agents
  //      within the pace, closes finished / ineligible requests — every 15 s.
  const AGENT_UNINSTALL_EXPIRY_INTERVAL_MS = 60 * 1000;
  const AGENT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
  const agentUninstallExpiryTimer = setInterval(async () => {
    try {
      await agentService.cleanupUninstalledDevices();
    } catch (err) {
      logger.error(err, 'Agent uninstall expiry job failed');
    }
  }, AGENT_UNINSTALL_EXPIRY_INTERVAL_MS);
  const agentCleanupTimer = setInterval(async () => {
    try {
      await agentService.cleanupStuckUpdating();
    } catch (err) {
      logger.error(err, 'Agent cleanup job failed');
    }
    try {
      await agentService.cleanupStaleTransfers();
    } catch (err) {
      logger.error(err, 'Agent stale transfer cleanup failed');
    }
  }, AGENT_CLEANUP_INTERVAL_MS);
  const agentRolloutTimer = setInterval(() => {
    void agentUpdateRollout.tick();
  }, UPDATE_ROLLOUT_TICK_MS);
  if (isLegacyAutoUpdate()) {
    logger.warn('AGENT_LEGACY_AUTO_UPDATE=true: agents self-update on every push (admin-paced rollout bypassed)');
  }

  // 10. Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    clearTimeout(retentionBootTimer);
    clearInterval(retentionTimer);
    clearInterval(agentCleanupTimer);
    clearInterval(agentUninstallExpiryTimer);
    clearInterval(agentRolloutTimer);
    maintenanceService.stopJobs();
    agentWss.close();
    await workerManager.stopAll();
    server.close();
    await db.destroy();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal(err, 'Failed to start server');
  process.exit(1);
});
