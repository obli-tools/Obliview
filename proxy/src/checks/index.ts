import type { ProxyMonitorConfig, CheckResult } from '../types.js';
import { httpCheck } from './http.js';
import { pingCheck } from './ping.js';
import { tcpCheck } from './tcp.js';
import { dnsCheck } from './dns.js';
import { sslCheck } from './ssl.js';
import { smtpCheck } from './smtp.js';
import { browserCheck } from './browser.js';
import { dockerCheck } from './docker.js';
import { gameServerCheck } from './gameServer.js';
import { scriptCheck } from './script.js';
import { valueWatcherCheck } from './valueWatcher.js';

export async function executeCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  switch (cfg.type) {
    case 'http':         return httpCheck(cfg);
    case 'json_api':     return httpCheck(cfg);
    case 'ping':         return pingCheck(cfg);
    case 'tcp':          return tcpCheck(cfg);
    case 'dns':          return dnsCheck(cfg);
    case 'ssl':          return sslCheck(cfg);
    case 'smtp':         return smtpCheck(cfg);
    case 'browser':      return browserCheck(cfg);
    case 'docker':       return dockerCheck(cfg);
    case 'game_server':  return gameServerCheck(cfg);
    case 'script':       return scriptCheck(cfg);
    case 'value_watcher': return valueWatcherCheck(cfg);
    default:
      return { status: 'down', message: `Unsupported monitor type: ${cfg.type}` };
  }
}
