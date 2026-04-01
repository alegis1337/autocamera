/**
 * browser.js — Playwright wrapper
 * Opens a browser, navigates to a dashboard, performs login, takes screenshot.
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import * as log from './logger.js';

const ROOT = path.resolve('.');
const SCREENSHOTS_DIR = path.join(ROOT, 'screenshots');

export function ensureScreenshotsDir() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

export function screenshotPath(label) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(SCREENSHOTS_DIR, `${label}-${ts}.png`);
}

/**
 * Launches Chromium, navigates to a camera dashboard, logs in if needed,
 * takes a screenshot, and closes the browser.
 */
export async function captureSystemScreenshot(system, creds) {
  const step = `${system.id}:browser`;
  const filePath = screenshotPath(system.id);
  let browser = null;

  try {
    log.stepStart(step, 'Запуск Chromium');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    const page = await context.newPage();
    log.info(step, 'Браузер запущен');

    // Navigate
    log.info(step, 'Переход на страницу', { url: creds.url });
    await page.goto(creds.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    log.info(step, 'Страница загружена');
    await page.waitForTimeout(2000);

    // Login if needed
    if (system.loginRequired !== false && creds.user) {
      log.info(step, 'Выполняю авторизацию', { type: system.type, user: creds.user });
      await performLogin(page, system, creds, step);
      await page.waitForTimeout(4000);
    }

    // Take screenshot
    await page.screenshot({ path: filePath, fullPage: false });
    const sizeKB = Math.round(fs.statSync(filePath).size / 1024);
    log.stepEnd(step, 'ok', 'Скриншот сохранён', {
      file: path.basename(filePath),
      size: `${sizeKB}KB`,
    });
    return { screenshotPath: filePath, error: null };

  } catch (err) {
    log.stepEnd(step, 'fail', 'Ошибка браузера', { error: err.message });
    return { screenshotPath: null, error: err.message };
  } finally {
    if (browser) await browser.close();
  }
}

async function performLogin(page, system, creds, step) {
  try {
    if (system.type === 'ipanda') {
      const userInput = page.locator('input[type="text"], input[name*="user"], input[name*="login"], input[placeholder*="user" i], input[placeholder*="логин" i]').first();
      const passInput = page.locator('input[type="password"]').first();
      const loginBtn = page.locator('button, input[type="submit"]').filter({ hasText: /логин|войти|вход|login/i }).first();

      await userInput.fill(creds.user);
      await passInput.fill(creds.pass);
      await loginBtn.click();

    } else if (system.type === 'hiwatch') {
      const userInput = page.locator('#username, input[name="username"], input[id*="user" i]').first();
      const passInput = page.locator('#password, input[name="password"], input[type="password"]').first();
      const loginBtn = page.locator('#loginBtn, button[type="submit"], input[type="submit"]').first();

      await userInput.fill(creds.user);
      await passInput.fill(creds.pass);
      await loginBtn.click();

    } else {
      await page.locator('input[type="text"]').first().fill(creds.user);
      await page.locator('input[type="password"]').first().fill(creds.pass);
      await page.locator('button[type="submit"], input[type="submit"]').first().click();
    }

    log.info(step, 'Авторизация выполнена', { type: system.type });
  } catch (err) {
    log.warn(step, 'Авторизация: элемент не найден (продолжаю)', { error: err.message });
  }
}

export function cleanOldScreenshots(days) {
  const cutoff = Date.now() - days * 86400_000;
  if (!fs.existsSync(SCREENSHOTS_DIR)) return;
  let deleted = 0;
  for (const file of fs.readdirSync(SCREENSHOTS_DIR)) {
    if (!file.endsWith('.png')) continue;
    const fullPath = path.join(SCREENSHOTS_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) { fs.unlinkSync(fullPath); deleted++; }
  }
  if (deleted > 0) log.info('cleanup', 'Удалены старые скриншоты', { count: deleted });
}
