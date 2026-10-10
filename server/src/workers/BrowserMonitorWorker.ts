import type { Browser } from 'playwright-chromium';
import { chromium } from 'playwright-chromium';
import { BaseMonitorWorker, type CheckResult } from './BaseMonitorWorker';
import { logger } from '../utils/logger';

// Shared browser instance across all BrowserMonitorWorker instances
let sharedBrowser: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;

async function getSharedBrowser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) {
    return sharedBrowser;
  }

  // Avoid multiple simultaneous launches
  if (browserLaunchPromise) {
    return browserLaunchPromise;
  }

  // CHROMIUM_PATH: use a system Chromium instead of Playwright's bundled
  // build (e.g. on a host where the bundled glibc build cannot run).
  const executablePath = process.env.CHROMIUM_PATH?.trim() || undefined;

  browserLaunchPromise = chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    sharedBrowser = await browserLaunchPromise;
    logger.info('Shared Playwright browser launched');

    // Relaunch on disconnect
    sharedBrowser.on('disconnected', () => {
      logger.warn('Shared Playwright browser disconnected');
      sharedBrowser = null;
      browserLaunchPromise = null;
    });

    return sharedBrowser;
  } catch (error) {
    browserLaunchPromise = null;
    throw error;
  }
}

export class BrowserMonitorWorker extends BaseMonitorWorker {
  async performCheck(): Promise<CheckResult> {
    const cfg = this.config;
    const url = cfg.browserUrl as string;
    const keyword = cfg.browserKeyword as string | null;
    const keywordIsPresent = cfg.browserKeywordIsPresent as boolean | null;
    const waitForSelector = cfg.browserWaitForSelector as string | null;
    const timeoutMs = cfg.timeoutMs;

    const startTime = Date.now();
    let context;

    try {
      const browser = await getSharedBrowser();

      // Create an isolated browser context for each check
      context = await browser.newContext({
        userAgent: 'Obliview/1.0 Browser Monitor',
        ignoreHTTPSErrors: true,
      });

      // Set a page-level timeout
      context.setDefaultTimeout(timeoutMs);

      const page = await context.newPage();

      // Navigate to the URL
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: timeoutMs,
      });

      // Wait for a specific selector if configured
      if (waitForSelector) {
        try {
          await page.waitForSelector(waitForSelector, { timeout: timeoutMs });
        } catch {
          const responseTime = Date.now() - startTime;
          return {
            status: 'down',
            responseTime,
            message: `Selector "${waitForSelector}" not found within ${timeoutMs}ms`,
          };
        }
      }

      // Check keyword in page content
      if (keyword) {
        const content = await page.content();
        const keywordFound = content.includes(keyword);
        const shouldBePresent = keywordIsPresent !== false;

        if (shouldBePresent && !keywordFound) {
          const responseTime = Date.now() - startTime;
          return {
            status: 'down',
            responseTime,
            message: `Keyword "${keyword}" not found in page content`,
          };
        }

        if (!shouldBePresent && keywordFound) {
          const responseTime = Date.now() - startTime;
          return {
            status: 'down',
            responseTime,
            message: `Keyword "${keyword}" found in page (should not be present)`,
          };
        }
      }

      const responseTime = Date.now() - startTime;

      return {
        status: 'up',
        responseTime,
        message: `Page loaded successfully (${responseTime}ms)`,
      };
    } catch (error) {
      const responseTime = Date.now() - startTime;
      const message = error instanceof Error ? error.message : 'Unknown browser error';

      // Detect timeout errors specifically
      if (message.includes('Timeout') || message.includes('timeout')) {
        return {
          status: 'down',
          responseTime,
          message: `Browser timeout after ${timeoutMs}ms`,
        };
      }

      return {
        status: 'down',
        responseTime,
        message: `Browser error: ${message}`,
      };
    } finally {
      // Always close the context to free resources
      if (context) {
        try {
          await context.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }
}
