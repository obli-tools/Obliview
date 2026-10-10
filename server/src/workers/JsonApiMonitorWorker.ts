import { Agent } from 'undici';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { checkSslCertificate } from './sslCheck';

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

export class JsonApiMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const url = this.config.url as string;
    const method = (this.config.method as string) || 'GET';
    const customHeaders = this.config.headers as Record<string, string> | null;
    const body = this.config.body as string | null;
    const jsonPath = this.config.jsonPath as string | null;
    const expectedValue = this.config.jsonExpectedValue as string | null;
    const ignoreSsl = this.config.ignoreSsl as boolean | undefined;
    const sslWarnDays = (this.config.sslWarnDays as number) || 30;

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Obliview/1.0',
        Accept: 'application/json',
        ...(customHeaders || {}),
      };

      const fetchOptions: Record<string, unknown> = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'follow',
      };

      if (body && ['POST', 'PUT', 'PATCH'].includes(method)) {
        fetchOptions.body = body;
      }

      // Use insecure agent for self-signed certificates
      if (ignoreSsl && url.startsWith('https')) {
        fetchOptions.dispatcher = insecureAgent;
      }

      const response = await fetch(url, fetchOptions as RequestInit);
      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `HTTP ${response.status}`,
        };
      }

      const data = await response.json();

      // Determine the "up" result first, then apply SSL check
      let upResult: CheckResult;

      // If no JSON path configured, just check that response is valid JSON
      if (!jsonPath) {
        upResult = {
          status: 'up',
          responseTime,
          statusCode: response.status,
          message: `JSON OK (${response.status})`,
        };
      } else {
        // Resolve JSON path (supports dot notation and $. prefix)
        const value = this.resolvePath(data, jsonPath);
        const valueStr = value === undefined ? 'undefined' : String(value);

        if (expectedValue !== null && expectedValue !== undefined) {
          if (valueStr === expectedValue) {
            upResult = {
              status: 'up',
              responseTime,
              statusCode: response.status,
              message: `${jsonPath} = "${valueStr}"`,
            };
          } else {
            return {
              status: 'down',
              responseTime,
              statusCode: response.status,
              message: `${jsonPath}: expected "${expectedValue}", got "${valueStr}"`,
            };
          }
        } else {
          // No expected value — just check the path exists and is truthy
          if (value !== undefined && value !== null && value !== false && value !== '') {
            upResult = {
              status: 'up',
              responseTime,
              statusCode: response.status,
              message: `${jsonPath} = "${valueStr}"`,
            };
          } else {
            return {
              status: 'down',
              responseTime,
              statusCode: response.status,
              message: `${jsonPath} is ${valueStr}`,
            };
          }
        }
      }

      // JSON API check passed — now verify SSL certificate if applicable
      if (url.startsWith('https://') && !ignoreSsl) {
        try {
          const parsedUrl = new URL(url);
          const sslHost = parsedUrl.hostname;
          const sslPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
          const sslResult = await checkSslCertificate(sslHost, sslPort, this.config.timeoutMs);

          if (sslResult.error) {
            return {
              status: 'ssl_expired',
              responseTime,
              statusCode: response.status,
              message: `SSL: ${sslResult.error}`,
            };
          }

          if (sslResult.daysRemaining < 0) {
            return {
              status: 'ssl_expired',
              responseTime,
              statusCode: response.status,
              message: `SSL certificate expired ${Math.abs(sslResult.daysRemaining)} days ago (${sslResult.expiryDate})`,
            };
          }

          if (sslResult.daysRemaining < sslWarnDays) {
            return {
              status: 'ssl_warning',
              responseTime,
              statusCode: response.status,
              message: `SSL certificate expires in ${sslResult.daysRemaining} days (${sslResult.expiryDate}) — threshold: ${sslWarnDays} days`,
            };
          }

          // SSL OK — append info to existing message
          upResult.message = `${upResult.message} | SSL OK, expires in ${sslResult.daysRemaining} days (${sslResult.expiryDate})`;
        } catch {
          return {
            status: 'ssl_expired',
            responseTime,
            statusCode: response.status,
            message: 'SSL certificate verification failed',
          };
        }
      }

      return upResult;
    } catch (error) {
      const responseTime = Date.now() - startTime;

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          status: 'down',
          responseTime,
          message: `Timeout after ${this.config.timeoutMs}ms`,
        };
      }

      return {
        status: 'down',
        responseTime,
        message: error instanceof Error ? error.message : 'Unknown error',
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Resolve a simple dot-notation path in a JSON object.
   * Supports: "status", "data.health", "$.data.status", "data[0].name"
   */
  private resolvePath(obj: unknown, path: string): unknown {
    // Strip leading $. prefix
    let cleanPath = path.startsWith('$.') ? path.slice(2) : path;
    // Strip leading $
    if (cleanPath.startsWith('$')) cleanPath = cleanPath.slice(1);

    const segments = cleanPath.split(/\.|\[(\d+)\]/).filter(Boolean);
    let current: unknown = obj;

    for (const segment of segments) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }

    return current;
  }
}
