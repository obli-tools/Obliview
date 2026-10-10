import dns from 'dns/promises';
import { Resolver } from 'dns/promises';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';

export class DnsMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const hostname = this.config.hostname as string;
    const recordType = (this.config.dnsRecordType as string) || 'A';
    const customResolver = this.config.dnsResolver as string | null;
    const expectedValue = this.config.dnsExpectedValue as string | null;

    const startTime = Date.now();

    try {
      let resolver: Resolver | typeof dns;
      if (customResolver) {
        const r = new Resolver();
        r.setServers([customResolver]);
        resolver = r;
      } else {
        resolver = dns;
      }

      const result = await Promise.race([
        this.resolve(resolver, hostname, recordType),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Timeout after ${this.config.timeoutMs}ms`)), this.config.timeoutMs),
        ),
      ]);

      const responseTime = Date.now() - startTime;
      const resultStr = Array.isArray(result) ? result.flat().join(', ') : String(result);

      // Check expected value if configured
      if (expectedValue) {
        const values = Array.isArray(result) ? result.flat().map(String) : [String(result)];
        const match = values.some((v) => v.includes(expectedValue));
        if (!match) {
          return {
            status: 'down',
            responseTime,
            message: `DNS ${recordType}: expected "${expectedValue}", got "${resultStr}"`,
          };
        }
      }

      return {
        status: 'up',
        responseTime,
        message: `DNS ${recordType}: ${resultStr}`,
      };
    } catch (error) {
      return {
        status: 'down',
        responseTime: Date.now() - startTime,
        message: error instanceof Error ? error.message : 'DNS lookup failed',
      };
    }
  }

  private async resolve(resolver: Resolver | typeof dns, hostname: string, recordType: string): Promise<unknown> {
    switch (recordType) {
      case 'A': return resolver.resolve4(hostname);
      case 'AAAA': return resolver.resolve6(hostname);
      case 'CNAME': return resolver.resolveCname(hostname);
      case 'MX': return (await resolver.resolveMx(hostname)).map((r) => `${r.priority} ${r.exchange}`);
      case 'TXT': return (await resolver.resolveTxt(hostname)).map((r) => r.join(''));
      case 'NS': return resolver.resolveNs(hostname);
      case 'SOA': {
        const soa = await resolver.resolveSoa(hostname);
        return `${soa.nsname} ${soa.hostmaster}`;
      }
      case 'SRV': return (await resolver.resolveSrv(hostname)).map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
      case 'PTR': return resolver.resolvePtr(hostname);
      default: return resolver.resolve4(hostname);
    }
  }
}
