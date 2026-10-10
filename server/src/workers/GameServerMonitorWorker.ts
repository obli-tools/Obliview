import { GameDig } from 'gamedig';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class GameServerMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const gameType = this.config.gameType as string;
    const host = this.config.gameHost as string;
    const port = this.config.gamePort as number | undefined;
    const startTime = Date.now();

    try {
      const result = await GameDig.query({
        type: gameType,
        host,
        port,
        maxRetries: 1,
        socketTimeout: this.config.timeoutMs,
        attemptTimeout: this.config.timeoutMs,
      });
      const responseTime = Date.now() - startTime;

      return {
        status: 'up',
        responseTime,
        ping: result.ping,
        message: `${result.name || gameType} - ${result.numplayers ?? 0}/${result.maxplayers ?? '?'} players`,
      };
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - startTime,
        message: error instanceof Error ? error.message : 'Game server query failed',
      };
    }
  }
}
