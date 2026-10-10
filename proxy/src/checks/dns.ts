import dns from 'node:dns';
import { Resolver } from 'node:dns/promises';
import type { ProxyMonitorConfig, CheckResult } from '../types.js';

export async function dnsCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const hostname = cfg.hostname;
  if (!hostname) return { status: 'down', message: 'No hostname provided' };

  const resolver = new Resolver();
  if (cfg.dnsResolver) {
    resolver.setServers([cfg.dnsResolver.includes(':') ? cfg.dnsResolver : `${cfg.dnsResolver}:53`]);
  }

  const recordType = cfg.dnsRecordType || 'A';
  const start = performance.now();

  try {
    let records: string[];

    switch (recordType) {
      case 'A':
      case 'AAAA':
        records = await resolver.resolve(hostname, recordType);
        break;
      case 'MX': {
        const mxRecords = await resolver.resolveMx(hostname);
        records = mxRecords.map((r) => `${r.exchange} (priority ${r.priority})`);
        break;
      }
      case 'CNAME':
        records = await resolver.resolveCname(hostname);
        break;
      case 'TXT': {
        const txtRecords = await resolver.resolveTxt(hostname);
        records = txtRecords.map((r) => r.join(''));
        break;
      }
      case 'NS':
        records = await resolver.resolveNs(hostname);
        break;
      default:
        records = await resolver.resolve(hostname);
    }

    const responseTime = Math.round(performance.now() - start);

    if (records.length === 0) {
      return { status: 'down', responseTime, message: 'No records found' };
    }

    const result: CheckResult = {
      status: 'up',
      responseTime,
      message: records.join(', '),
    };

    if (cfg.dnsExpectedValue) {
      const expected = cfg.dnsExpectedValue.replace(/\.$/, '');
      const found = records.some((r) => r.replace(/\.$/, '') === expected);
      if (!found) {
        result.status = 'down';
        result.message = `Expected "${cfg.dnsExpectedValue}" not found in ${result.message}`;
      }
    }

    return result;
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'DNS lookup failed' };
  }
}
