import http from 'node:http';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function dockerCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const dockerHost = cfg.dockerHost;
  const containerName = cfg.dockerContainerName;
  if (!dockerHost || !containerName) {
    return { status: 'down', message: 'Docker host and container name required' };
  }

  const timeout = cfg.timeoutMs || 10000;
  const start = performance.now();

  try {
    // Build the URL for the Docker API
    let apiUrl: string;
    if (dockerHost.startsWith('tcp://')) {
      apiUrl = `http://${dockerHost.slice(6)}/containers/${encodeURIComponent(containerName)}/json`;
    } else if (dockerHost.startsWith('http://') || dockerHost.startsWith('https://')) {
      apiUrl = `${dockerHost}/containers/${encodeURIComponent(containerName)}/json`;
    } else {
      // Unix socket path
      const body = await fetchViaUnixSocket(
        dockerHost,
        `/containers/${encodeURIComponent(containerName)}/json`,
        timeout,
      );
      const responseTime = Math.round(performance.now() - start);
      const data = JSON.parse(body);
      const running = data?.State?.Running === true;
      return {
        status: running ? 'up' : 'down',
        responseTime,
        message: running ? `Container ${containerName} is running` : `Container ${containerName} is not running (state: ${data?.State?.Status ?? 'unknown'})`,
      };
    }

    const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(timeout) });
    const responseTime = Math.round(performance.now() - start);
    const data = await resp.json() as { State?: { Running?: boolean; Status?: string } };
    const running = data?.State?.Running === true;

    return {
      status: running ? 'up' : 'down',
      responseTime,
      message: running
        ? `Container ${containerName} is running`
        : `Container ${containerName} is not running (state: ${data?.State?.Status ?? 'unknown'})`,
    };
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'Docker check failed' };
  }
}

function fetchViaUnixSocket(socketPath: string, path: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, timeout }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Unix socket timeout')); });
    req.end();
  });
}
