import { exec } from 'child_process';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class ScriptMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const command = this.config.scriptCommand as string;
    const expectedExit = (this.config.scriptExpectedExit as number) ?? 0;
    const startTime = Date.now();

    return new Promise<CheckResult>((resolve) => {
      exec(
        command,
        { timeout: this.config.timeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const responseTime = Date.now() - startTime;
          const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number | string }).code : 0;

          // exec sets error.killed on timeout
          if (error && (error as { killed?: boolean }).killed) {
            resolve({
              status: 'down',
              responseTime,
              message: `Script timed out after ${this.config.timeoutMs}ms`,
            });
            return;
          }

          const actualExit = typeof exitCode === 'number' ? exitCode : (error ? 1 : 0);

          if (actualExit === expectedExit) {
            const output = (stdout || '').trim().slice(0, 200);
            resolve({
              status: 'up',
              responseTime,
              message: output || `Exit code: ${actualExit}`,
            });
          } else {
            const errOutput = (stderr || stdout || '').trim().slice(0, 200);
            resolve({
              status: 'down',
              responseTime,
              message: `Exit code ${actualExit} (expected ${expectedExit})${errOutput ? ': ' + errOutput : ''}`,
            });
          }
        },
      );
    });
  }
}
