import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { db } from '../db';

/**
 * Simple JSONPath resolver that supports dot notation and bracket syntax.
 * Supports paths like: $.data.value, data.items[0].price, response.total
 */
function resolveJsonPath(obj: unknown, path: string): unknown {
  // Remove leading $. if present
  let normalizedPath = path.startsWith('$.') ? path.slice(2) : path;
  if (normalizedPath.startsWith('$')) normalizedPath = normalizedPath.slice(1);
  if (normalizedPath.startsWith('.')) normalizedPath = normalizedPath.slice(1);

  const parts: string[] = [];
  // Split by . and [] while handling brackets
  const regex = /([^.\[\]]+)|\[(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(normalizedPath)) !== null) {
    parts.push(match[1] || match[2]);
  }

  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

type Operator = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'between' | 'changed';

function evaluateCondition(
  value: number,
  operator: Operator,
  threshold: number,
  thresholdMax: number | null,
): boolean {
  switch (operator) {
    case '>': return value > threshold;
    case '<': return value < threshold;
    case '>=': return value >= threshold;
    case '<=': return value <= threshold;
    case '==': return value === threshold;
    case '!=': return value !== threshold;
    case 'between':
      if (thresholdMax === null) return value >= threshold;
      return value >= threshold && value <= thresholdMax;
    default:
      return false;
  }
}

export class ValueWatcherMonitorWorker extends BaseMonitorWorker {
  private previousValue: string | null = null;

  async performCheck(): Promise<CheckResult> {
    const cfg = this.config;
    const url = cfg.valueWatcherUrl as string;
    const jsonPath = cfg.valueWatcherJsonPath as string;
    const operator = cfg.valueWatcherOperator as Operator;
    const threshold = cfg.valueWatcherThreshold as number | null;
    const thresholdMax = cfg.valueWatcherThresholdMax as number | null;
    const customHeaders = cfg.valueWatcherHeaders as Record<string, string> | null;

    // Load previous value from config (first run) or from memory
    if (this.previousValue === null && cfg.valueWatcherPreviousValue) {
      this.previousValue = cfg.valueWatcherPreviousValue as string;
    }

    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Obliview/1.0',
        'Accept': 'application/json',
        ...(customHeaders || {}),
      };

      const response = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      const responseTime = Date.now() - startTime;

      if (!response.ok) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const json = await response.json();
      const rawValue = resolveJsonPath(json, jsonPath);

      if (rawValue === undefined || rawValue === null) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `JSON path "${jsonPath}" returned no value`,
        };
      }

      const currentValueStr = String(rawValue);

      // Handle 'changed' operator separately
      if (operator === 'changed') {
        const oldValue = this.previousValue;
        this.previousValue = currentValueStr;

        // Persist the current value to database
        await this.persistPreviousValue(currentValueStr);

        // First check — no previous value to compare
        if (oldValue === null) {
          return {
            status: 'up',
            responseTime,
            statusCode: response.status,
            message: `Value: ${currentValueStr} (initial reading)`,
            value: currentValueStr,
          };
        }

        if (currentValueStr !== oldValue) {
          return {
            status: 'up',
            responseTime,
            statusCode: response.status,
            message: `Value changed: ${oldValue} → ${currentValueStr}`,
            value: currentValueStr,
            valueChanged: true,
          };
        }

        return {
          status: 'up',
          responseTime,
          statusCode: response.status,
          message: `Value unchanged: ${currentValueStr}`,
          value: currentValueStr,
        };
      }

      // Numeric comparison operators
      const numValue = Number(rawValue);
      if (isNaN(numValue)) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `Value "${currentValueStr}" is not a number (path: ${jsonPath})`,
          value: currentValueStr,
        };
      }

      if (threshold === null) {
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: 'No threshold configured',
          value: currentValueStr,
        };
      }

      const conditionMet = evaluateCondition(numValue, operator, threshold, thresholdMax);

      // Store current value for reference
      this.previousValue = currentValueStr;
      await this.persistPreviousValue(currentValueStr);

      if (conditionMet) {
        const conditionStr = operator === 'between'
          ? `${threshold} ≤ ${numValue} ≤ ${thresholdMax}`
          : `${numValue} ${operator} ${threshold}`;
        return {
          status: 'up',
          responseTime,
          statusCode: response.status,
          message: `Value: ${numValue} (${conditionStr} ✓)`,
          value: currentValueStr,
        };
      } else {
        const conditionStr = operator === 'between'
          ? `${numValue} not in [${threshold}, ${thresholdMax}]`
          : `${numValue} ${operator} ${threshold} is false`;
        return {
          status: 'down',
          responseTime,
          statusCode: response.status,
          message: `Value: ${numValue} (${conditionStr} ✗)`,
          value: currentValueStr,
        };
      }
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

  /** Persist the last fetched value back to the monitor row for persistence across restarts */
  private async persistPreviousValue(value: string): Promise<void> {
    try {
      await db('monitors')
        .where({ id: this.config.id })
        .update({ value_watcher_previous_value: value });
    } catch {
      // Non-critical — value will be re-fetched on next check
    }
  }
}
