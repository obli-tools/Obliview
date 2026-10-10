import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function gameServerCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const { gameType, gameHost, gamePort } = cfg;
  if (!gameType || !gameHost) {
    return { status: 'down', message: 'Game type and host required' };
  }

  const start = performance.now();
  try {
    const { GameDig } = await import('gamedig');
    const result = await GameDig.query({
      type: gameType as any,
      host: gameHost,
      port: gamePort || undefined,
      maxRetries: 1,
      socketTimeout: cfg.timeoutMs || 10000,
    });

    const responseTime = Math.round(performance.now() - start);
    return {
      status: 'up',
      responseTime,
      ping: result.ping,
      message: `${result.name} — ${result.numplayers}/${result.maxplayers} players`,
    };
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'Game server unreachable' };
  }
}
