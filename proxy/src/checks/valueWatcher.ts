import type { ProxyMonitorConfig, CheckResult } from '../types.js';

/** In-memory store for previous values (per monitorId) to detect changes. */
const previousValues = new Map<number, string>();

export async function valueWatcherCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const url = cfg.valueWatcherUrl || cfg.url;
  if (!url) return { status: 'down', message: 'No URL provided' };
  if (!cfg.valueWatcherJsonPath) return { status: 'down', message: 'No JSON path provided' };

  const timeout = cfg.timeoutMs || 10000;
  const start = performance.now();

  try {
    const resp = await fetch(url, {
      headers: cfg.valueWatcherHeaders,
      signal: AbortSignal.timeout(timeout),
    });

    const responseTime = Math.round(performance.now() - start);
    const body = await resp.text();
    const value = extractJsonPath(body, cfg.valueWatcherJsonPath);

    const result: CheckResult = {
      status: 'up',
      responseTime,
      statusCode: resp.status,
      message: `Value: ${value}`,
      value,
    };

    const operator = cfg.valueWatcherOperator;
    const threshold = cfg.valueWatcherThreshold;

    if (operator && operator !== 'changed' && threshold != null) {
      const numVal = parseFloat(value);
      if (isNaN(numVal)) {
        result.status = 'down';
        result.message = `Value "${value}" is not a number`;
        return result;
      }

      let pass = false;
      switch (operator) {
        case '>':  pass = numVal > threshold; break;
        case '<':  pass = numVal < threshold; break;
        case '>=': pass = numVal >= threshold; break;
        case '<=': pass = numVal <= threshold; break;
        case '==': pass = numVal === threshold; break;
        case '!=': pass = numVal !== threshold; break;
        case 'between':
          pass = numVal >= threshold && numVal <= (cfg.valueWatcherThresholdMax ?? Infinity);
          break;
      }

      if (!pass) {
        result.status = 'down';
        result.message = `Value ${value} failed condition ${operator} ${threshold}${operator === 'between' ? `-${cfg.valueWatcherThresholdMax}` : ''}`;
      }
    }

    // 'changed' operator: fire notification when value differs from previous
    if (operator === 'changed') {
      const prev = previousValues.get(cfg.monitorId);
      if (prev !== undefined && prev !== value) {
        result.valueChanged = true;
        result.message = `Value changed: ${prev} → ${value}`;
      }
      previousValues.set(cfg.monitorId, value);
    }

    return result;
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'Value watcher failed' };
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
