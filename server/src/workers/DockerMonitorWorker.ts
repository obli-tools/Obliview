import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class DockerMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const dockerHost = this.config.dockerHost as string;
    const containerName = this.config.dockerContainerName as string;
    const startTime = Date.now();

    try {
      // Build the Docker API URL
      let baseUrl: string;
      if (dockerHost.startsWith('tcp://')) {
        baseUrl = dockerHost.replace('tcp://', 'http://');
      } else if (dockerHost.startsWith('http://') || dockerHost.startsWith('https://')) {
        baseUrl = dockerHost;
      } else {
        // Unix socket - use fetch with unix socket via http
        // Node.js fetch doesn't support unix sockets natively;
        // fall back to http module for unix socket
        return this.checkViaUnixSocket(dockerHost, containerName, startTime);
      }

      const url = `${baseUrl}/containers/${encodeURIComponent(containerName)}/json`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

      try {
        const response = await fetch(url, { signal: controller.signal });
        const responseTime = Date.now() - startTime;

        if (!response.ok) {
          return {
            status: 'down',
            responseTime,
            message: `Container not found: ${response.status}`,
          };
        }

        const data = (await response.json()) as { State?: { Status?: string; Running?: boolean } };
        const state = data.State;

        if (state?.Running) {
          return {
            status: 'up',
            responseTime,
            message: `Container running (${state.Status})`,
          };
        }

        return {
          status: 'down',
          responseTime,
          message: `Container not running: ${state?.Status || 'unknown'}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - startTime,
        message: error instanceof Error ? error.message : 'Docker check failed',
      };
    }
  }

  private async checkViaUnixSocket(
    socketPath: string,
    containerName: string,
    startTime: number,
  ): Promise<CheckResult> {
    const http = await import('http');

    return new Promise<CheckResult>((resolve) => {
      const timer = setTimeout(() => {
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `Timeout after ${this.config.timeoutMs}ms`,
        });
      }, this.config.timeoutMs);

      const req = http.request(
        {
          socketPath,
          path: `/containers/${encodeURIComponent(containerName)}/json`,
          method: 'GET',
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            clearTimeout(timer);
            const responseTime = Date.now() - startTime;

            if (res.statusCode !== 200) {
              resolve({
                status: 'down',
                responseTime,
                message: `Container not found: ${res.statusCode}`,
              });
              return;
            }

            try {
              const data = JSON.parse(body);
              if (data.State?.Running) {
                resolve({
                  status: 'up',
                  responseTime,
                  message: `Container running (${data.State.Status})`,
                });
              } else {
                resolve({
                  status: 'down',
                  responseTime,
                  message: `Container not running: ${data.State?.Status || 'unknown'}`,
                });
              }
            } catch {
              resolve({ status: 'down', responseTime, message: 'Failed to parse Docker response' });
            }
          });
        },
      );

      req.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          status: 'down',
          responseTime: Date.now() - startTime,
          message: `Docker error: ${err.message}`,
        });
      });

      req.end();
    });
  }
}
