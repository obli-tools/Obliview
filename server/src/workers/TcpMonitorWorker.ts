import net from 'net';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class TcpMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const hostname = this.config.hostname as string;
    const port = this.config.port as number;
    const startTime = Date.now();

    return new Promise<CheckResult>((resolve) => {
      const socket = new net.Socket();

      const timer = setTimeout(() => {
        socket.destroy();
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `Timeout after ${this.config.timeoutMs}ms`,
        });
      }, this.config.timeoutMs);

      socket.connect(port, hostname, () => {
        clearTimeout(timer);
        const responseTime = Date.now() - startTime;
        socket.destroy();
        resolve({
          status: 'up',
          responseTime,
          message: `TCP port ${port} open on ${hostname}`,
        });
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `TCP error: ${err.message}`,
        });
      });
    });
  }
}
