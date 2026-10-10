import { Router, type Request, type Response } from 'express';
import { db } from '../db';
import { PushMonitorWorker } from '../workers/PushMonitorWorker';
import { logger } from '../utils/logger';

const router = Router();

/**
 * monitors.last_push_at is written at most once per this interval per monitor.
 * It only has to survive a server restart (PushMonitorWorker seeds its
 * in-memory map from it), so a few seconds of lag is irrelevant while a
 * chatty pusher (every second) must not turn into one UPDATE per request.
 */
const LAST_PUSH_PERSIST_INTERVAL_MS = 10_000;

/** monitorId → unix-ms of the last last_push_at write */
const lastPersistedAt = new Map<number, number>();

function persistLastPush(monitorId: number, now: number): void {
  const previous = lastPersistedAt.get(monitorId);
  if (previous !== undefined && now - previous < LAST_PUSH_PERSIST_INTERVAL_MS) return;
  lastPersistedAt.set(monitorId, now);

  db('monitors')
    .where({ id: monitorId })
    .update({ last_push_at: new Date(now) })
    .catch((err: unknown) => {
      // Not reset on failure: the next attempt stays throttled, so a failing
      // write cannot turn into one log line per push.
      logger.warn(err, `Failed to persist last_push_at for push monitor ${monitorId}`);
    });
}

/**
 * POST /api/heartbeat/:token
 * GET  /api/heartbeat/:token
 *
 * Public endpoint for push monitors. External systems call this URL
 * to signal they are alive. No authentication required — the token
 * itself is the secret.
 */
router.all('/:token', async (req: Request, res: Response) => {
  try {
    const { token } = req.params;

    // Find the monitor with this push token
    const monitor = await db('monitors')
      .where({ push_token: token, type: 'push' })
      .first('id', 'is_active', 'status');

    if (!monitor) {
      res.status(404).json({ success: false, error: 'Invalid push token' });
      return;
    }

    if (!monitor.is_active || monitor.status === 'paused') {
      res.status(200).json({ success: true, message: 'Monitor is paused' });
      return;
    }

    // Record the push timestamp (in memory for the worker, throttled in the
    // DB so it survives a server restart).
    PushMonitorWorker.recordPush(monitor.id);
    persistLastPush(monitor.id, Date.now());

    res.json({ success: true, message: 'OK' });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export default router;
