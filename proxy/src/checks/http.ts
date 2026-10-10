import tls from 'node:tls';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

const DEFAULT_STATUS_CODES = [200, 201, 204, 301, 302];

export async function httpCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const url = cfg.url;
  if (!url) return { status: 'down', message: 'No URL provided' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs || 10000);

  const start = performance.now();
  try {
    const resp = await fetch(url, {
      method: cfg.method || 'GET',
      headers: cfg.headers,
      body: cfg.method !== 'GET' && cfg.method !== 'HEAD' ? cfg.body : undefined,
      signal: controller.signal,
      redirect: 'follow',
      // @ts-expect-error Node.js fetch supports this
      dispatcher: cfg.ignoreSsl
        ? new (await import('node:https')).Agent({ rejectUnauthorized: false })
        : undefined,
    });
    const responseTime = Math.round(performance.now() - start);
    const bodyText = await resp.text();

    const result: CheckResult = {
      status: 'up',
      responseTime,
      statusCode: resp.status,
      message: `${resp.status} ${resp.statusText}`,
    };

    // Status code check
    const expected = cfg.expectedStatusCodes?.length ? cfg.expectedStatusCodes : DEFAULT_STATUS_CODES;
    if (!expected.includes(resp.status)) {
      result.status = 'down';
      result.message = `Status ${resp.status} not in expected codes`;
      return result;
    }

    // Keyword check
    if (cfg.keyword) {
      const found = bodyText.includes(cfg.keyword);
      if (cfg.keywordIsPresent && !found) {
        result.status = 'down';
        result.message = `Keyword '${cfg.keyword}' not found`;
      } else if (!cfg.keywordIsPresent && found) {
        result.status = 'down';
        result.message = `Keyword '${cfg.keyword}' found (should be absent)`;
      }
    }

    // JSON path extraction (json_api type)
    if (cfg.jsonPath) {
      const val = extractJsonPath(bodyText, cfg.jsonPath);
      result.value = val;
      if (cfg.jsonExpectedValue && val !== cfg.jsonExpectedValue) {
        result.status = 'down';
        result.message = `JSON path ${cfg.jsonPath}: got "${val}", expected "${cfg.jsonExpectedValue}"`;
      }
    }

    // SSL certificate check for https URLs
    if (url.startsWith('https://') && !cfg.ignoreSsl) {
      const sslResult = await checkSslCert(url, cfg.sslWarnDays ?? 30);
      if (sslResult) {
        result.status = sslResult.status;
        result.message = sslResult.message;
      }
    }

    return result;
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return {
      status: 'down',
      responseTime,
      message: err instanceof Error ? err.message : 'Request failed',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function checkSslCert(url: string, warnDays: number): Promise<{ status: string; message: string } | null> {
  try {
    const { hostname, port } = new URL(url);
    const cert = await new Promise<tls.PeerCertificate>((resolve, reject) => {
      const sock = tls.connect({ host: hostname, port: parseInt(port) || 443, servername: hostname }, () => {
        resolve(sock.getPeerCertificate());
        sock.destroy();
      });
      sock.on('error', reject);
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('SSL timeout')); });
    });

    if (!cert.valid_to) return null;
    const expiry = new Date(cert.valid_to);
    const daysLeft = Math.floor((expiry.getTime() - Date.now()) / 86400000);

    if (daysLeft <= 0) {
      return { status: 'down', message: `SSL certificate expired ${-daysLeft} days ago` };
    }
    if (daysLeft <= warnDays) {
      return { status: 'up', message: `SSL certificate expires in ${daysLeft} days` };
    }
    return null;
  } catch {
    return null;
  }
}

function extractJsonPath(body: string, path: string): string {
  try {
    let current: unknown = JSON.parse(body);
    for (const part of path.split('.')) {
      const bracketIdx = part.indexOf('[');
      if (bracketIdx >= 0) {
        const key = part.slice(0, bracketIdx);
        const idx = parseInt(part.slice(bracketIdx + 1, -1), 10);
        current = (current as Record<string, unknown>)?.[key];
        current = (current as unknown[])?.[idx];
      } else {
        current = (current as Record<string, unknown>)?.[part];
      }
    }
    return current == null ? '' : String(current);
  } catch {
    return '';
  }
}
