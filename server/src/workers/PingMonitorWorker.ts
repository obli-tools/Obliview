import { exec } from 'child_process';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class PingMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const hostname = this.config.hostname as string;

    const isWindows = process.platform === 'win32';
    const cmd = isWindows
      ? `ping -n 1 -w ${this.config.timeoutMs} ${hostname}`
      : `ping -c 1 -W ${Math.ceil(this.config.timeoutMs / 1000)} ${hostname}`;

    const startTime = Date.now();

    return new Promise<CheckResult>((resolve) => {
      exec(cmd, { timeout: this.config.timeoutMs + 1000 }, (error, stdout) => {
        const responseTime = Date.now() - startTime;

        if (error) {
          resolve({
            status: 'down',
            responseTime,
            message: `Ping failed: ${hostname}`,
          });
          return;
        }

        // Extract ping time from output
        let ping: number | undefined;
        // Windows: "Average = 12ms" or "time=12ms"
        // Linux/Mac: "time=12.3 ms"
        const timeMatch = stdout.match(/time[<=](\d+\.?\d*)\s*ms/i);
        if (timeMatch) {
          ping = parseFloat(timeMatch[1]);
        }

        resolve({
          status: 'up',
          responseTime,
          ping,
          message: `Ping OK: ${ping !== undefined ? `${ping}ms` : `${responseTime}ms`}`,
        });
      });
    });
  }
}
