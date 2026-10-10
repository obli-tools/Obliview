import tls from 'tls';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class SslMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const hostname = this.config.hostname as string;
    const port = (this.config.port as number) || 443;
    const warnDays = (this.config.sslWarnDays as number) || 30;
    const startTime = Date.now();

    return new Promise<CheckResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `Timeout after ${this.config.timeoutMs}ms`,
        });
      }, this.config.timeoutMs);

      const socket = tls.connect(
        {
          host: hostname,
          port,
          servername: hostname,
          rejectUnauthorized: false, // We check the cert ourselves
        },
        () => {
          clearTimeout(timer);
          const responseTime = Date.now() - startTime;
          const cert = socket.getPeerCertificate();
          socket.destroy();

          if (!cert || !cert.valid_to) {
            resolve({
              status: 'down',
              responseTime,
              message: 'No SSL certificate found',
            });
            return;
          }

          const expiryDate = new Date(cert.valid_to);
          const now = new Date();
          const daysRemaining = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

          if (daysRemaining < 0) {
            resolve({
              status: 'down',
              responseTime,
              message: `SSL certificate expired ${Math.abs(daysRemaining)} days ago`,
            });
          } else if (daysRemaining < warnDays) {
            // Certificate still valid: orange badge, but the heartbeat row
            // stays 'up' so the warning period does not count as downtime.
            resolve({
              status: 'ssl_warning',
              heartbeatStatus: 'up',
              responseTime,
              message: `SSL certificate expires in ${daysRemaining} days (warning threshold: ${warnDays} days)`,
            });
          } else {
            resolve({
              status: 'up',
              responseTime,
              message: `SSL OK - expires in ${daysRemaining} days (${expiryDate.toISOString().split('T')[0]})`,
            });
          }
        },
      );

      socket.on('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `SSL error: ${err.message}`,
        });
      });
    });
  }
}
