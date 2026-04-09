#!/usr/bin/env node

import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const SOURCE_CHROME_DIR = '/Users/huangju/Library/Application Support/Google/Chrome';
const SOURCE_PROFILE_DIR = path.join(SOURCE_CHROME_DIR, 'Profile 2');
const SOURCE_LOCAL_STATE = path.join(SOURCE_CHROME_DIR, 'Local State');
const CHROME_EXECUTABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TARGET_URL = 'http://localhost:1234/';
const QUERY_TEXT = process.env.REMOTE_HISTORY_QUERY || '本月';
const REMOTE_DEBUGGING_PORT = 9223;
const VIEWPORT = { width: 1600, height: 1200 };

const PROFILE_FILES = [
  'Cookies',
  'Cookies-journal',
];

const PROFILE_DIRS = [
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'WebStorage',
  'Storage',
];

function log(message) {
  // eslint-disable-next-line no-console
  console.log(`[remote-smoke] ${message}`);
}

async function copyIfExists(source, target) {
  if (!fs.existsSync(source)) {
    return false;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  return true;
}

async function prepareChromeProfile() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-tt-remote-smoke-'));
  const tempProfileDir = path.join(tempRoot, 'Profile 2');
  await mkdir(tempProfileDir, { recursive: true });

  await copyIfExists(SOURCE_LOCAL_STATE, path.join(tempRoot, 'Local State'));

  for (const fileName of PROFILE_FILES) {
    await copyIfExists(
      path.join(SOURCE_PROFILE_DIR, fileName),
      path.join(tempProfileDir, fileName),
    );
  }

  for (const dirName of PROFILE_DIRS) {
    await copyIfExists(
      path.join(SOURCE_PROFILE_DIR, dirName),
      path.join(tempProfileDir, dirName),
    );
  }

  const serviceWorkerDir = path.join(tempProfileDir, 'Service Worker');
  if (fs.existsSync(serviceWorkerDir)) {
    await rm(serviceWorkerDir, { recursive: true, force: true });
  }

  return tempRoot;
}

function _readTexts(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function _waitForAny(page, selectors, timeoutMs = 120_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const selector of selectors) {
      const count = await page.locator(selector).count().catch(() => 0);
      if (count > 0) {
        return selector;
      }
    }
    await page.waitForTimeout(1000);
  }

  return undefined;
}

async function _domClick(locator) {
  await locator.evaluate((node) => {
    if (node instanceof HTMLElement) {
      node.click();
      return;
    }

    throw new Error('Locator target is not clickable');
  });
}

async function _dumpFailureContext(page, tempUserDataDir, prefix) {
  const bodyText = await page.locator('body').textContent().catch(() => '');
  const buttonLabels = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
    ariaLabel: button.getAttribute('aria-label') || '',
    text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
    className: button.getAttribute('class') || '',
  }))).catch(() => []);
  const screenshotPath = path.join(tempUserDataDir, `${prefix}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
  await writeFile(
    path.join(tempUserDataDir, `${prefix}.txt`),
    [
      `url: ${page.url()}`,
      `buttonLabels: ${JSON.stringify(buttonLabels.slice(0, 160), undefined, 2)}`,
      `bodyText: ${(bodyText || '').slice(0, 12000)}`,
      `screenshot: ${screenshotPath}`,
    ].join('\n\n'),
  );
}

async function waitForChromeDevtools(port, timeoutMs = 60_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
        cache: 'no-store',
      });
      if (response.ok) {
        return await response.json();
      }
    } catch {
      // Keep waiting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Chrome remote debugging port ${port} did not become ready`);
}

function launchChrome(tempUserDataDir) {
  const child = spawn(CHROME_EXECUTABLE, [
    `--user-data-dir=${tempUserDataDir}`,
    '--profile-directory=Profile 2',
    `--remote-debugging-port=${REMOTE_DEBUGGING_PORT}`,
    '--remote-allow-origins=*',
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--headless=new',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    // eslint-disable-next-line no-console
    console.log(`[chrome stdout] ${String(chunk).trimEnd()}`);
  });
  child.stderr.on('data', (chunk) => {
    // eslint-disable-next-line no-console
    console.log(`[chrome stderr] ${String(chunk).trimEnd()}`);
  });

  return child;
}

function buildRemoteHistoryQuery(queryText) {
  const compact = queryText.trim().toLowerCase().replace(/\s+/g, '');

  if (
    compact.includes('上周')
    || compact.includes('lastweek')
    || compact.includes('previousweek')
    || compact.includes('上一周')
    || compact.includes('前一周')
  ) {
    return {
      mode: 'range',
      timeRange: { mode: 'preset', value: 'lastWeek' },
      remoteOnly: true,
      limit: 100,
    };
  }

  if (
    compact.includes('今天')
    || compact.includes('today')
  ) {
    return {
      mode: 'range',
      timeRange: { mode: 'preset', value: 'today' },
      remoteOnly: true,
      limit: 100,
    };
  }

  return {
    mode: 'range',
    timeRange: { mode: 'preset', value: 'thisMonth' },
    remoteOnly: true,
    limit: 100,
  };
}

async function main() {
  if (!fs.existsSync(SOURCE_PROFILE_DIR)) {
    throw new Error(`Chrome profile not found: ${SOURCE_PROFILE_DIR}`);
  }

  const tempUserDataDir = await prepareChromeProfile();
  log(`temp profile: ${tempUserDataDir}`);

  const chromeProcess = launchChrome(tempUserDataDir);
  await waitForChromeDevtools(REMOTE_DEBUGGING_PORT);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${REMOTE_DEBUGGING_PORT}`);
  const context = browser.contexts()[0] || await browser.newContext();
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('tt-ignore-compat', '1');
    } catch {
      // Ignore storage init failures; the page will still report incompatibility if needed.
    }
  });

  const page = context.pages()[0] || await context.newPage();
  const cdpSession = await context.newCDPSession(page);
  try {
    await cdpSession.send('Emulation.setDeviceMetricsOverride', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: VIEWPORT.width,
      screenHeight: VIEWPORT.height,
      dontSetVisibleSize: false,
    });
    await cdpSession.send('Emulation.setVisibleSize', {
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });
  } catch (error) {
    log(`device metrics override skipped: ${error?.message || error}`);
  }
  await page.setViewportSize(VIEWPORT).catch(() => {});

  let pageClosed = false;
  let browserDisconnected = false;
  page.on('close', () => {
    pageClosed = true;
    log('page closed');
  });
  browser.on('disconnected', () => {
    browserDisconnected = true;
    log('browser disconnected');
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.error(`[browser console] ${msg.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    // eslint-disable-next-line no-console
    console.error(`[pageerror] ${error.message}`);
  });

  try {
    log(`opening ${TARGET_URL}`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForTimeout(2000);

    log('waiting for target chat hook');
    await page.waitForFunction(() => typeof window.TEST_openChatByTitle === 'function', {
      timeout: 60_000,
    });

    const openChatResult = await page.evaluate(() => {
      const hook = window.TEST_openChatByTitle;
      if (typeof hook !== 'function') {
        throw new Error('TEST_openChatByTitle is not installed');
      }

      return hook('VAULTA LEGENDS');
    }).catch((error) => ({ error: error?.message || String(error) }));
    log(`open chat result: ${JSON.stringify(openChatResult)}`);

    const currentMessageList = await page
      .evaluate(() => window.TEST_getCurrentMessageList?.() ?? undefined)
      .catch(() => undefined);
    log(`current message list: ${JSON.stringify(currentMessageList)}`);

    await page.waitForFunction(() => typeof window.TEST_runMessageFetch === 'function', {
      timeout: 60_000,
    });

    const query = buildRemoteHistoryQuery(QUERY_TEXT);
    const tabId = await page.evaluate(() => window.TEST_getCurrentTabId?.() ?? 1);

    log(`triggering direct message fetch: ${JSON.stringify(query)}`);
    const result = await page.evaluate(({ queryPayload, currentTabId }) => {
      const hook = window.TEST_runMessageFetch;
      if (typeof hook !== 'function') {
        throw new Error('TEST_runMessageFetch is not installed');
      }

      return hook({
        query: queryPayload,
        tabId: currentTabId,
      });
    }, { queryPayload: query, currentTabId: tabId });

    const messages = Array.isArray(result?.messages) ? result.messages : [];
    const sourceMessages = Array.isArray(result?.sourceMessages) ? result.sourceMessages : [];
    const firstMessage = messages[0];
    const lastMessage = messages[messages.length - 1];
    const byDay = messages.reduce((acc, message) => {
      const day = new Date((message.date || 0) * 1000).toISOString().slice(0, 10);
      acc.set(day, (acc.get(day) || 0) + 1);
      return acc;
    }, new Map());

    log('--- result ---');
    log(`total: ${result?.total ?? 0}`);
    log(`truncated: ${Boolean(result?.truncated)}`);
    log(`messages.length: ${messages.length}`);
    log(`sourceMessages.length: ${sourceMessages.length}`);
    log(`nextBeforeMessageId: ${result?.nextBeforeMessageId ?? 'n/a'}`);
    log(`days: ${JSON.stringify(Array.from(byDay.entries()))}`);
    if (firstMessage) {
      const firstText = firstMessage.text || firstMessage.action?.type || '';
      log(`first: ${firstMessage.messageId} ${firstMessage.sender} ${firstText}`);
    }
    if (lastMessage && lastMessage !== firstMessage) {
      log(`last: ${lastMessage.messageId} ${lastMessage.sender} ${lastMessage.text || lastMessage.action?.type || ''}`);
    }

    if (result?.nextBeforeMessageId) {
      const secondQuery = {
        ...query,
        beforeMessageId: result.nextBeforeMessageId - 1,
      };
      log(`triggering page-2 fetch: ${JSON.stringify(secondQuery)}`);
      const secondResult = await page.evaluate(({ queryPayload, currentTabId }) => {
        const hook = window.TEST_runMessageFetch;
        if (typeof hook !== 'function') {
          throw new Error('TEST_runMessageFetch is not installed');
        }

        return hook({
          query: queryPayload,
          tabId: currentTabId,
        });
      }, { queryPayload: secondQuery, currentTabId: tabId });

      const secondMessages = Array.isArray(secondResult?.messages) ? secondResult.messages : [];
      const secondByDay = secondMessages.reduce((acc, message) => {
        const day = new Date((message.date || 0) * 1000).toISOString().slice(0, 10);
        acc.set(day, (acc.get(day) || 0) + 1);
        return acc;
      }, new Map());
      log(`page-2 total: ${secondResult?.total ?? 0}`);
      log(`page-2 truncated: ${Boolean(secondResult?.truncated)}`);
      log(`page-2 days: ${JSON.stringify(Array.from(secondByDay.entries()))}`);
      const secondFirst = secondMessages[0];
      const secondLast = secondMessages[secondMessages.length - 1];
      if (secondFirst) {
        const secondFirstText = secondFirst.text || secondFirst.action?.type || '';
        log(`page-2 first: ${secondFirst.messageId} ${secondFirst.sender} ${secondFirstText}`);
      }
      if (secondLast && secondLast !== secondFirst) {
        const secondLastText = secondLast.text || secondLast.action?.type || '';
        log(`page-2 last: ${secondLast.messageId} ${secondLast.sender} ${secondLastText}`);
      }
    }

    log('triggering sanity recent-500 fetch');
    const recentResult = await page.evaluate(({ currentTabId }) => {
      const hook = window.TEST_runMessageFetch;
      if (typeof hook !== 'function') {
        throw new Error('TEST_runMessageFetch is not installed');
      }

      return hook({
        query: {
          mode: 'recent',
          limit: 500,
          remoteOnly: true,
        },
        tabId: currentTabId,
      });
    }, { currentTabId: tabId });

    const recentMessages = Array.isArray(recentResult?.messages) ? recentResult.messages : [];
    const recentByDay = recentMessages.reduce((acc, message) => {
      const day = new Date((message.date || 0) * 1000).toISOString().slice(0, 10);
      acc.set(day, (acc.get(day) || 0) + 1);
      return acc;
    }, new Map());
    log(`recent-500 total: ${recentResult?.total ?? 0}`);
    log(`recent-500 truncated: ${Boolean(recentResult?.truncated)}`);
    log(`recent-500 days: ${JSON.stringify(Array.from(recentByDay.entries()))}`);
    const recentFirst = recentMessages[0];
    const recentLast = recentMessages[recentMessages.length - 1];
    if (recentFirst) {
      const recentFirstText = recentFirst.text || recentFirst.action?.type || '';
      log(`recent-500 first: ${recentFirst.messageId} ${recentFirst.sender} ${recentFirstText}`);
    }
    if (recentLast && recentLast !== recentFirst) {
      const recentLastText = recentLast.text || recentLast.action?.type || '';
      log(`recent-500 last: ${recentLast.messageId} ${recentLast.sender} ${recentLastText}`);
    }
    log(`pageClosed: ${pageClosed}`);
    log(`browserDisconnected: ${browserDisconnected}`);
  } finally {
    await browser.close().catch(() => {});
    chromeProcess.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!chromeProcess.killed) {
      chromeProcess.kill('SIGKILL');
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
