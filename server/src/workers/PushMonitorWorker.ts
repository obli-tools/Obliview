import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { db } from '../db';
import { logger } from '../utils/logger';
import { SERVER_START_TIME } from '../utils/serverStartTime';

/** Boot time + persistence throttle covered by the restart grace (see performCheck). */
const RESTART_DEADLINE_SLACK_MS = 60_000;

/**
 * Push (passive) monitor worker.
 *
 * Instead of actively checking a target, this worker waits for external
 * systems to push heartbeats to `POST /api/heartbeat/:token`.
 *
 * The worker simply checks how long since the last push was received.
 * If no push arrives within pushMaxIntervalSec, the monitor goes DOWN.
 *
 * The actual push timestamp is stored in a static Map, updated by the
 * push heartbeat route. The route also persists it (throttled) in
 * monitors.last_push_at, which seeds the map after a server restart.
 */
export class PushMonitorWorker extends BaseMonitorWorker {
  /** Map of monitorId → last push timestamp */
  static lastPushTimes = new Map<number, number>();

  /** True once this worker has tried to seed lastPushTimes from monitors.last_push_at. */
  private seededFromDb = false;

  async performCheck(): Promise<CheckResult> {
    const maxInterval = (this.config.pushMaxIntervalSec as number) || 300;

    if (!this.seededFromDb) {
      this.seededFromDb = true;
      await this.seedLastPushFromDb();
    }

    const lastPush = PushMonitorWorker.lastPushTimes.get(this.config.id);
    const elapsed = lastPush !== undefined ? (Date.now() - lastPush) / 1000 : null;

    if (elapsed !== null && elapsed <= maxInterval) {
      return {
        status: 'up',
        responseTime: Math.round(elapsed * 1000),
        message: `Last push ${Math.round(elapsed)}s ago`,
      };
    }

    // Startup grace period (mirrors AgentMonitorWorker): the pusher may have
    // tried to reach us while the server was down, so give it one full push
    // interval after a restart before declaring the monitor DOWN. Returning
    // the last confirmed status is a no-op for the state machine (no retry
    // accumulation, no notification).
    // The grace only applies when the deadline fell while we were down (or
    // during boot, before the route was listening / the 10 s persistence
    // throttle) or nothing is known. A deadline still ahead at restart means
    // any push since then would have been recorded, so no grace is needed.
    const pushedSinceStart = lastPush !== undefined && lastPush >= SERVER_START_TIME;
    const deadline = lastPush !== undefined ? lastPush + maxInterval * 1000 : undefined;
    const deadlineMissedWhileDown =
      deadline === undefined || deadline < SERVER_START_TIME + RESTART_DEADLINE_SLACK_MS;
    if (!pushedSinceStart && deadlineMissedWhileDown && Date.now() - SERVER_START_TIME < maxInterval * 1000) {
      return {
        status: this.getConfirmedStatus(),
        message: lastPush !== undefined
          ? `Server restarted — waiting for next push (last push ${Math.round(elapsed!)}s ago, max: ${maxInterval}s)`
          : 'Server restarted — waiting for first push...',
      };
    }

    if (elapsed === null) {
      return {
        status: 'down',
        message: 'Waiting for first push...',
      };
    }

    return {
      status: 'down',
      message: `No push received for ${Math.round(elapsed)}s (max: ${maxInterval}s)`,
    };
  }

  /**
   * Seed the in-memory timestamp from monitors.last_push_at when nothing was
   * recorded since the server started (restart, or worker started on a
   * monitor that has not pushed yet in this process).
   */
  private async seedLastPushFromDb(): Promise<void> {
    if (PushMonitorWorker.lastPushTimes.has(this.config.id)) return;
    try {
      const row = await db('monitors')
        .where({ id: this.config.id })
        .select('last_push_at')
        .first() as { last_push_at: Date | string | null } | undefined;
      if (!row?.last_push_at) return;
      const ts = new Date(row.last_push_at).getTime();
      // A live push may have landed while we were querying — never overwrite it.
      if (!Number.isNaN(ts) && !PushMonitorWorker.lastPushTimes.has(this.config.id)) {
        PushMonitorWorker.lastPushTimes.set(this.config.id, ts);
      }
    } catch (err) {
      logger.warn(err, `Push monitor ${this.config.id}: could not read last_push_at`);
    }
  }

  /** Called by the push heartbeat route */
  static recordPush(monitorId: number): void {
    PushMonitorWorker.lastPushTimes.set(monitorId, Date.now());
  }
}
