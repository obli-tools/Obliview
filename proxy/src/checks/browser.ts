import type { ProxyMonitorConfig, CheckResult } from '../types.js';

let browserInstance: import('playwright-chromium').Browser | null = null;

async function getBrowser(): Promise<import('playwright-chromium').Browser> {
  if (browserInstance?.isConnected()) return browserInstance;
  const { chromium } = await import('playwright-chromium');
  browserInstance = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  console.log('Playwright browser launched');
  return browserInstance;
}

export async function browserCheck(cfg: ProxyMonitorConfig): Promise<CheckResult> {
  const url = cfg.browserUrl || cfg.url;
  if (!url) return { status: 'down', message: 'No browser URL provided' };

  const timeout = cfg.timeoutMs || 30000;
  const start = performance.now();

  let context: import('playwright-chromium').BrowserContext | null = null;
  try {
    const browser = await getBrowser();
    context = await browser.newContext({ ignoreHTTPSErrors: cfg.ignoreSsl ?? false });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    // Optional: wait for a specific CSS selector
    if (cfg.browserWaitForSelector) {
      await page.waitForSelector(cfg.browserWaitForSelector, { timeout: timeout / 2 });
    }

    // Optional: keyword check in page content
    if (cfg.browserKeyword) {
      const content = await page.content();
      const found = content.includes(cfg.browserKeyword);
      const shouldBePresent = cfg.browserKeywordIsPresent ?? true;

      if (shouldBePresent && !found) {
        return {
          status: 'down',
          responseTime: Math.round(performance.now() - start),
          message: `Keyword '${cfg.browserKeyword}' not found in page`,
        };
      }
      if (!shouldBePresent && found) {
        return {
          status: 'down',
          responseTime: Math.round(performance.now() - start),
          message: `Keyword '${cfg.browserKeyword}' found (should be absent)`,
        };
      }
    }

    const responseTime = Math.round(performance.now() - start);
    return { status: 'up', responseTime, message: `Page loaded (${responseTime}ms)` };
  } catch (err) {
    const responseTime = Math.round(performance.now() - start);
    return { status: 'down', responseTime, message: err instanceof Error ? err.message : 'Browser check failed' };
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
