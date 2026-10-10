import tls from 'node:tls';
import net from 'node:net';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function sslCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const hostname = cfg.hostname;
  const port = cfg.port || 443;
  if (!hostname) return { status: 'down', message: 'No hostname provided' };

  const timeout = cfg.timeoutMs || 10000;
  const start = performance.now();

  try {
    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const socket = tls.connect(
        { host: hostname, port, servername: hostname, timeout },
        () => {
          resolve(socket.getPeerCertificate());
          socket.destroy();
        },
      );
      socket.on('error', reject);
      socket.setTimeout(timeout, () => { socket.destroy(); reject(new Error('Connection timeout')); });
    });

    const responseTime = Math.round(performance.now() - start);

    if (!cert.valid_to) {
      return { status: 'down', responseTime, message: 'No certificate presented' };
    }

    const expiry = new Date(cert.valid_to);
    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400000);
    const warnDays = cfg.sslWarnDays ?? 30;
    const subject = cert.subject?.CN || hostname;
    const issuer = cert.issuer?.CN || 'unknown';

    if (daysLeft <= 0) {
      return { status: 'down', responseTime, message: `SSL expired ${-daysLeft} days ago (${subject})` };
    }

    const msg = daysLeft <= warnDays
      ? `SSL expires in ${daysLeft} days (${subject})`
      : `SSL valid, expires in ${daysLeft} days (${subject}, issuer: ${issuer})`;

    return { status: 'up', responseTime, message: msg };
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'SSL check failed' };
  }
}
