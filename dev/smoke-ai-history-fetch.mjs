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
const QUERY = process.env.AI_SMOKE_QUERY || '上周聊了什么';
const REMOTE_DEBUGGING_PORT = 9222;
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
  console.log(`[smoke] ${message}`);
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
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'telegram-tt-ai-smoke-'));
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

function readTexts(page, selector) {
  return page.locator(selector).evaluateAll((nodes) => nodes
    .map((node) => (node.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
}

async function waitForAny(page, selectors, timeoutMs = 120_000) {
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

    try {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        get: () => 1600,
      });
      Object.defineProperty(window, 'innerHeight', {
        configurable: true,
        get: () => 1200,
      });
      const originalMatchMedia = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (query.includes('(max-width: 600px)') || query.includes('(max-width: 1275px)')) {
          return {
            matches: false,
            media: query,
            onchange: undefined,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
          };
        }

        return originalMatchMedia(query);
      };
    } catch {
      // Ignore viewport override failures; the real page layout may still work.
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

    const layoutSnapshot = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      mobile: window.matchMedia('(max-width: 600px)').matches,
      tablet: window.matchMedia('(max-width: 1275px)').matches,
      bodyClass: document.body.className,
      mainClass: document.getElementById('Main')?.className || '',
    })).catch(() => undefined);
    if (layoutSnapshot) {
      log(`layout snapshot: ${JSON.stringify(layoutSnapshot)}`);
    }

    log('waiting for target chat');
    const targetChat = page.getByRole('button', { name: /VAULTA LEGENDS/ }).first();
    await targetChat.waitFor({ timeout: 120_000 });
    await targetChat.scrollIntoViewIfNeeded().catch(() => {});
    await targetChat.click({ force: true, timeout: 20_000 });
    await page.waitForTimeout(2000);

    log('waiting for AI Assistant button');
    try {
      await page.getByRole('button', { name: 'AI Assistant' }).waitFor({ timeout: 120_000 });
    } catch (error) {
      const bodyText = await page.locator('body').textContent().catch(() => '');
      const buttonLabels = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
        ariaLabel: button.getAttribute('aria-label') || '',
        text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
        className: button.getAttribute('class') || '',
      }))).catch(() => []);
      const screenshotPath = path.join(tempUserDataDir, 'ai-history-smoke-ai-button-failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await writeFile(
        path.join(tempUserDataDir, 'ai-history-smoke-ai-button-failure.txt'),
        [
          `url: ${page.url()}`,
          `buttonLabels: ${JSON.stringify(buttonLabels.slice(0, 120), undefined, 2)}`,
          `bodyText: ${(bodyText || '').slice(0, 8000)}`,
          `screenshot: ${screenshotPath}`,
        ].join('\n\n'),
      );
      throw error;
    }
    const aiButton = page.getByRole('button', { name: 'AI Assistant' });
    await aiButton.scrollIntoViewIfNeeded().catch(() => {});
    await aiButton.click({ force: true, timeout: 20_000 });

    const rightColumn = page.locator('#RightColumn-wrapper');
    const composer = page.locator('.AiAssistant__composer-shell input.form-control');
    try {
      await page.waitForFunction(
        () => Boolean(document.querySelector('.AiAssistant__composer-shell input.form-control')),
        {
          timeout: 60_000,
        },
      );
    } catch (error) {
      const rightWrapperClass = await rightColumn.getAttribute('class').catch(() => '');
      const bodyText = await page.locator('body').textContent().catch(() => '');
      const buttonLabels = await page.locator('button').evaluateAll((buttons) => buttons.map((button) => ({
        ariaLabel: button.getAttribute('aria-label') || '',
        text: (button.textContent || '').replace(/\s+/g, ' ').trim(),
        className: button.getAttribute('class') || '',
      }))).catch(() => []);
      const screenshotPath = path.join(tempUserDataDir, 'ai-history-smoke-right-column-failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await writeFile(
        path.join(tempUserDataDir, 'ai-history-smoke-right-column-failure.txt'),
        [
          `url: ${page.url()}`,
          `rightWrapperClass: ${rightWrapperClass || ''}`,
          `buttonLabels: ${JSON.stringify(buttonLabels.slice(0, 120), undefined, 2)}`,
          `bodyText: ${(bodyText || '').slice(0, 8000)}`,
          `screenshot: ${screenshotPath}`,
        ].join('\n\n'),
      );
      throw error;
    }
    await page.waitForTimeout(1000);

    log('waiting for composer');
    try {
      await composer.waitFor({ timeout: 60_000 });
    } catch (error) {
      const wrapperClass = await rightColumn.getAttribute('class').catch(() => '');
      const wrapperText = await rightColumn.textContent().catch(() => '');
      const bodyText = await page.locator('body').textContent().catch(() => '');
      const screenshotPath = path.join(tempUserDataDir, 'ai-history-smoke-failure.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
      await writeFile(
        path.join(tempUserDataDir, 'ai-history-smoke-failure.txt'),
        [
          `url: ${page.url()}`,
          `wrapperClass: ${wrapperClass || ''}`,
          `rightColumnText: ${wrapperText || ''}`,
          `bodyText: ${(bodyText || '').slice(0, 8000)}`,
          `screenshot: ${screenshotPath}`,
        ].join('\n\n'),
      );
      throw error;
    }
    await composer.evaluate((input, queryText) => {
      const element = input;
      element.focus();
      element.value = queryText;
      element.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      element.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }, QUERY);
    const composerState = await page.evaluate(() => {
      const input = document.querySelector('.AiAssistant__composer-shell input.form-control');
      const send = document.querySelector('.AiAssistant__send');
      return {
        value: input instanceof HTMLInputElement ? input.value : '',
        sendDisabled: Boolean(send instanceof HTMLButtonElement && send.disabled),
      };
    }).catch(() => undefined);
    if (composerState) {
      log(`composer state: ${JSON.stringify(composerState)}`);
    }
    await page.waitForTimeout(500);
    await page.locator('.AiAssistant__send').click({ force: true, timeout: 20_000 });

    log(`submitted query: ${QUERY}`);

    const firstTraceSelector = await waitForAny(page, [
      '.AiAssistant__thinkingStep',
      '.AiAssistant__toolCard',
      '.AiAssistant__error',
      '.AiAssistant__message.is-assistant:not(.is-live)',
    ]);

    if (firstTraceSelector) {
      log(`first visible result: ${firstTraceSelector}`);
    }

    const snapshots = [];
    const seenSnapshots = new Set();
    const startedAt = Date.now();

    while (Date.now() - startedAt < 180_000) {
      if (pageClosed || browserDisconnected) {
        break;
      }
      const thinkingTitleTexts = await readTexts(page, '.AiAssistant__thinkingStepTitle').catch(() => []);
      const thinkingDetailTexts = await readTexts(page, '.AiAssistant__thinkingStepDetail').catch(() => []);
      const toolCardTexts = await readTexts(page, '.AiAssistant__toolCardDetail').catch(() => []);
      const assistantSelector = '.AiAssistant__message.is-assistant:not(.is-live) .AiAssistant__message-text';
      const assistantAnswers = await readTexts(page, assistantSelector).catch(() => []);
      const errorText = await page.locator('.AiAssistant__error').textContent().catch(() => '');
      const liveCount = await page.locator('.AiAssistant__liveRun').count().catch(() => 0);

      const key = JSON.stringify({
        thinkingTitleTexts,
        thinkingDetailTexts,
        toolCardTexts,
        assistantAnswers,
        errorText,
        liveCount,
      });

      if (!seenSnapshots.has(key)) {
        seenSnapshots.add(key);
        snapshots.push({
          thinkingTitleTexts,
          thinkingDetailTexts,
          toolCardTexts,
          assistantAnswers,
          errorText: errorText || '',
          liveCount,
        });
      }

      if (!liveCount && assistantAnswers.length) {
        break;
      }

      try {
        await page.waitForTimeout(1500);
      } catch (error) {
        log(`wait interrupted: ${error?.message || error}`);
        break;
      }
    }

    // Expand the latest completed thinking log if it is collapsed.
    const disclosure = page.locator('.AiAssistant__thinkingDisclosure').last();
    if (await disclosure.count()) {
      const expanded = await disclosure.getAttribute('class');
      if (!expanded?.includes('is-expanded')) {
        const header = disclosure.locator('.AiAssistant__thinkingHeader');
        if (await header.count()) {
          await header.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    }

    const finalThinkingTitles = await readTexts(page, '.AiAssistant__thinkingStepTitle').catch(() => []);
    const finalThinkingDetails = await readTexts(page, '.AiAssistant__thinkingStepDetail').catch(() => []);
    const finalToolCards = await readTexts(page, '.AiAssistant__toolCardDetail').catch(() => []);
    const finalAssistantSelector = '.AiAssistant__message.is-assistant:not(.is-live) .AiAssistant__message-text';
    const finalAssistantAnswers = await readTexts(page, finalAssistantSelector).catch(() => []);
    const finalError = await page.locator('.AiAssistant__error').textContent().catch(() => '');

    log('--- snapshots ---');
    snapshots.forEach((snapshot, index) => {
      log(
        `snapshot ${index + 1}:`
        + ` live=${snapshot.liveCount}`
        + ` answers=${snapshot.assistantAnswers.length}`
        + ` tools=${snapshot.toolCardTexts.length}`,
      );
      if (snapshot.errorText) {
        log(`  error: ${snapshot.errorText}`);
      }
      if (snapshot.toolCardTexts.length) {
        snapshot.toolCardTexts.forEach((text) => log(`  tool: ${text}`));
      }
      if (snapshot.thinkingTitleTexts.length) {
        snapshot.thinkingTitleTexts.forEach((text) => log(`  step: ${text}`));
      }
      if (snapshot.thinkingDetailTexts.length) {
        snapshot.thinkingDetailTexts.forEach((text) => log(`  detail: ${text}`));
      }
    });

    log('--- final ---');
    log(`thinking steps: ${finalThinkingTitles.length}`);
    finalThinkingTitles.forEach((text) => log(`  step: ${text}`));
    finalThinkingDetails.forEach((text) => log(`  detail: ${text}`));
    finalToolCards.forEach((text) => log(`  tool card: ${text}`));
    finalAssistantAnswers.forEach((text) => log(`  answer: ${text}`));
    if (finalError) {
      log(`error: ${finalError}`);
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
    // Keep the temp profile around on failure so it can be inspected if needed.
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(error);
  process.exitCode = 1;
});
