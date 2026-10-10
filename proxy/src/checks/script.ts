import { exec } from 'node:child_process';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function scriptCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const command = cfg.scriptCommand;
  if (!command) return { status: 'down', message: 'No script command provided' };

  const expectedExit = cfg.scriptExpectedExit ?? 0;
  const timeout = cfg.timeoutMs || 30000;
  const start = performance.now();

  return new Promise((resolve) => {
    exec(command, { timeout, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const responseTime = Math.round(performance.now() - start);
      const exitCode = err?.code ?? (err ? 1 : 0);
      const actualExit = typeof exitCode === 'number' ? exitCode : 1;

      if (actualExit === expectedExit) {
        resolve({
          status: 'up',
          responseTime,
          message: stdout.trim().slice(0, 200) || `Exit code ${actualExit}`,
        });
      } else {
        resolve({
          status: 'down',
          responseTime,
          message: `Exit code ${actualExit} (expected ${expectedExit}): ${(stderr || stdout).trim().slice(0, 200)}`,
        });
      }
    });
  });
}
