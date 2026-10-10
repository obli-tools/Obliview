import net from 'node:net';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function smtpCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const host = cfg.smtpHost || cfg.hostname;
  const port = cfg.smtpPort || 25;
  if (!host) return { status: 'down', message: 'No SMTP host provided' };

  const timeout = cfg.timeoutMs || 10000;
  const start = performance.now();

  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);

    socket.connect(port, host, () => {
      socket.once('data', (data) => {
        const responseTime = Math.round(performance.now() - start);
        const banner = data.toString().trim();
        socket.destroy();

        if (banner.startsWith('220')) {
          resolve({ status: 'up', responseTime, message: banner });
        } else {
          resolve({ status: 'down', responseTime, message: `SMTP banner: ${banner}` });
        }
      });
    });

    socket.on('error', (err) => {
      const responseTime = Math.round(performance.now() - start);
      socket.destroy();
      resolve({ status: 'down', responseTime, message: err.message });
    });

    socket.on('timeout', () => {
      const responseTime = Math.round(performance.now() - start);
      socket.destroy();
      resolve({ status: 'down', responseTime, message: 'SMTP connection timeout' });
    });
  });
}
