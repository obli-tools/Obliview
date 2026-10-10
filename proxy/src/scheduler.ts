import { sendProxyResult } from './wsClient.js';
import { executeCheck } from './checks/index.js';
import type { ProxyMonitorConfig, CheckResult } from './types.js';

interface Runner {
  config: ProxyMonitorConfig;
  timer: ReturnType<typeof setInterval>;
}

const runners = new Map<number, Runner>();

/**
 * Reconcile the running monitors with the server-provided list.
 * Stops removed monitors, starts new ones, restarts changed ones.
 */
export function handleProxySync(monitors: ProxyMonitorConfig[]): void {
  const desired = new Map(monitors.map((m) => [m.monitorId, m]));

  // Stop monitors no longer in the desired set.
  for (const [id, runner] of runners) {
    if (!desired.has(id)) {
      console.log(`Stopping monitor ${id} (removed)`);
      clearInterval(runner.timer);
      runners.delete(id);
    }
  }

  // Start or update monitors.
  for (const [id, cfg] of desired) {
    const existing = runners.get(id);
    if (existing) {
      if (JSON.stringify(existing.config) === JSON.stringify(cfg)) continue;
      // Config changed — restart.
      console.log(`Restarting monitor ${id} (config changed)`);
      clearInterval(existing.timer);
      runners.delete(id);
    }

    console.log(`Starting monitor ${id} (type=${cfg.type}, interval=${cfg.intervalSeconds}s)`);
    startMonitor(cfg);
  }

  console.log(`${runners.size} proxy monitor(s) active`);
}

/** Stop all running monitors (called on WS disconnect). */
export function stopAllMonitors(): void {
  for (const [id, runner] of runners) {
    clearInterval(runner.timer);
    runners.delete(id);
  }
  console.log('All proxy monitors stopped');
}

function startMonitor(cfg: ProxyMonitorConfig): void {
  // Run immediately, then on interval.
  runCheck(cfg);

  const interval = Math.max(cfg.intervalSeconds, 5) * 1000;
  const timer = setInterval(() => runCheck(cfg), interval);
  runners.set(cfg.monitorId, { config: cfg, timer });
}

async function runCheck(cfg: ProxyMonitorConfig): Promise<void> {
  try {
    const result = await executeCheck(cfg);
    sendProxyResult(cfg.monitorId, result);
  } catch (err) {
    const result: CheckResult = {
      status: 'down',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
    sendProxyResult(cfg.monitorId, result);
  }
}
