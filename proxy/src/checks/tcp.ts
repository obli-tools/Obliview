import net from 'node:net';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function tcpCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const { hostname, port, timeoutMs = 10000 } = cfg;
  if (!hostname || !port) return { status: 'down', message: 'Hostname and port required' };

  const start = performance.now();
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, hostname, () => {
      const responseTime = Math.round(performance.now() - start);
      socket.destroy();
      resolve({ status: 'up', responseTime, message: `TCP ${hostname}:${port} open` });
    });

    socket.on('error', (err) => {
      const responseTime = Math.round(performance.now() - start);
      socket.destroy();
      resolve({ status: 'down', responseTime, message: err.message });
    });

    socket.on('timeout', () => {
      const responseTime = Math.round(performance.now() - start);
      socket.destroy();
      resolve({ status: 'down', responseTime, message: `Connection timeout (${timeoutMs}ms)` });
    });
  });
}
