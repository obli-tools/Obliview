import net from 'net';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class SmtpMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const host = (this.config.smtpHost as string) || (this.config.hostname as string);
    const port = (this.config.smtpPort as number) || (this.config.port as number) || 25;
    const startTime = Date.now();

    return new Promise<CheckResult>((resolve) => {
      const socket = new net.Socket();
      let banner = '';
      let step: 'banner' | 'ehlo' | 'done' = 'banner';

      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `Timeout after ${this.config.timeoutMs}ms`,
        });
      }, this.config.timeoutMs);

      const finish = (status: 'up' | 'down', message: string) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          status,
          responseTime: Date.now() - startTime,
          message,
        });
      };

      socket.connect(port, host, () => {
        // Wait for banner
      });

      socket.on('data', (data) => {
        const response = data.toString();

        if (step === 'banner') {
          banner = response.trim().split('\n')[0];
          if (response.startsWith('220')) {
            step = 'ehlo';
            socket.write('EHLO obliview\r\n');
          } else {
            finish('down', `Unexpected banner: ${banner}`);
          }
        } else if (step === 'ehlo') {
          if (response.startsWith('250')) {
            step = 'done';
            socket.write('QUIT\r\n');
            finish('up', `SMTP OK: ${banner}`);
          } else {
            finish('down', `EHLO rejected: ${response.trim().split('\n')[0]}`);
          }
        }
      });

      socket.on('error', (err) => {
        finish('down', `SMTP error: ${err.message}`);
      });
    });
  }
}
