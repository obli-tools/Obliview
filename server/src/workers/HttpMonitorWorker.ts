import { Agent } from 'undici';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { checkSslCertificate } from './sslCheck';

const insecureAgent = new Agent({
  connect: { rejectUnauthorized: false },
});

export class HttpMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const cfg = this.config;
    const url = cfg.url as string;
    const method = (cfg.method as string) || 'GET';
    const customHeaders = cfg.headers as Record<string, string> | null;
    const body = cfg.body as string | null;
    const expectedStatusCodes = cfg.expectedStatusCodes as number[] | null;
    const keyword = cfg.keyword as string | null;
    const keywordIsPresent = cfg.keywordIsPresent as boolean | undefined;
    const ignoreSsl = cfg.ignoreSsl as boolean | undefined;
    const sslWarnDays = (cfg.sslWarnDays as number) || 30;

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Obliview/1.0',
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

      // Check status code
      const expectedCodes = expectedStatusCodes || [200, 201, 204, 301, 302];
      if (!expectedCodes.includes(response.status)) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `Unexpected status code: ${response.status}`,
        };
      }

      // Check keyword if configured
      if (keyword) {
        const text = await response.text();
        const keywordFound = text.includes(keyword);
        const shouldBePresent = keywordIsPresent !== false;

        if (shouldBePresent && !keywordFound) {
          return {
            status: 'down',
            responseTime,
            statusCode: response.status,
            message: `Keyword "${keyword}" not found in response`,
          };
        }

        if (!shouldBePresent && keywordFound) {
          return {
            status: 'down',
            responseTime,
            statusCode: response.status,
            message: `Keyword "${keyword}" found in response (should not be present)`,
          };
        }
      }

      // HTTP check passed — now verify SSL certificate if applicable
      if (url.startsWith('https://') && !ignoreSsl) {
        try {
          const parsedUrl = new URL(url);
          const sslHost = parsedUrl.hostname;
          const sslPort = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;
          const sslResult = await checkSslCertificate(sslHost, sslPort, cfg.timeoutMs);

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
            // The site answered correctly: the badge goes orange but the
            // heartbeat row stays 'up' so an expiring certificate does not
            // count as downtime in uptime %.
            return {
              status: 'ssl_warning',
              heartbeatStatus: 'up',
              responseTime,
              statusCode: response.status,
              message: `SSL certificate expires in ${sslResult.daysRemaining} days (${sslResult.expiryDate}) — threshold: ${sslWarnDays} days`,
            };
          }

          // SSL OK — include info in message
          return {
            status: 'up',
            responseTime,
            statusCode: response.status,
            message: `${response.status} - ${response.statusText} | SSL OK, expires in ${sslResult.daysRemaining} days (${sslResult.expiryDate})`,
          };
        } catch {
          // If SSL check fails but HTTP was fine, report as ssl_expired
          return {
            status: 'ssl_expired',
            responseTime,
            statusCode: response.status,
            message: 'SSL certificate verification failed',
          };
        }
      }

      return {
        status: 'up',
        responseTime,
        statusCode: response.status,
        message: `${response.status} - ${response.statusText}`,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;

      if (error instanceof Error && error.name === 'AbortError') {
        return {
          status: 'down',
          responseTime,
          message: `Timeout after ${cfg.timeoutMs}ms`,
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
}
