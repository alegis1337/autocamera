/**
 * AutoCamera Monitor — Main Pipeline
 *
 * Usage:
 *   node src/index.js                             — полный запуск
 *   node src/index.js --dry-run                   — без отправки email
 *   node src/index.js --test-email                — тестовый email
 *   node src/index.js --dry-run --only noviy-ceh  — только одна система
 *   node src/index.js --debug                     — подробные логи
 */

import fs from 'fs';
import path from 'path';
import * as log from './logger.js';

import {
  captureSystemScreenshot,
  ensureScreenshotsDir,
  cleanOldScreenshots,
} from './browser.js';
import { analyzeScreenshot } from './analyzer.js';
import { buildReport, sendReport, cleanOldReports } from './reporter.js';

// ─── Load .env ────────────────────────────────────────────────────────────────
const dotenvPath = path.resolve('.env');
if (fs.existsSync(dotenvPath)) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config();
}

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const isDryRun    = args.includes('--dry-run');
const isTestEmail = args.includes('--test-email');
const isDebug     = args.includes('--debug');
const onlyId      = (() => {
  const idx = args.indexOf('--only');
  return idx >= 0 ? args[idx + 1] : null;
})();

if (isDebug) log.setLogLevel('DEBUG');

// ─── Load systems config ──────────────────────────────────────────────────────
const ROOT = path.resolve('.');
const systemsConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'systems.json'), 'utf8')
);

// ─── Ensure directories ───────────────────────────────────────────────────────
ensureScreenshotsDir();
fs.mkdirSync(path.join(ROOT, 'reports'), { recursive: true });
fs.mkdirSync(path.join(ROOT, 'logs'),    { recursive: true });

// ─── Test email mode ──────────────────────────────────────────────────────────
if (isTestEmail) {
  log.info('test', 'Режим тестового email');
  const reportPath = buildReport({
    systemResults: [{
      id: 'test', name: 'Test System',
      cameras: [{ index: 0, online: true, recording: true, audio: false, notes: 'test' }],
      screenshotPath: null, error: null, aiSummary: 'Test run',
    }],
    runMeta: { startTime: Date.now(), durationMs: 0 },
  });
  try {
    await sendReport({ reportPath, issueCount: 0, runTime: Date.now(), screenshotPaths: [] });
    log.info('test', 'Тестовый email отправлен');
  } catch (err) {
    log.error('test', 'Не удалось отправить email', { error: err.message });
  }
  process.exit(0);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
const startTime = Date.now();
log.section('AutoCamera Monitor — запуск');
log.info('startup', 'Конфигурация загружена', {
  systems: systemsConfig.length,
  mode: isDryRun ? 'dry-run' : 'full',
  only: onlyId || 'all',
  model: process.env.POLZA_MODEL || 'google/gemini-3.1-flash-lite-preview',
});

// Проверяем наличие API ключа
if (!process.env.POLZA_API_KEY) {
  log.error('startup', 'POLZA_API_KEY не задан в .env — AI анализ работать не будет');
}

const systems = systemsConfig.filter(sys => {
  if (sys.enabled === false) return false;
  if (onlyId && sys.id !== onlyId) return false;
  return true;
});

if (systems.length === 0) {
  log.warn('startup', 'Нет систем для проверки', { only: onlyId });
  process.exit(0);
}

log.info('startup', `Систем к проверке: ${systems.length}`, {
  ids: systems.map(s => s.id).join(', '),
});

const systemResults = [];

for (let i = 0; i < systems.length; i++) {
  const sys = systems[i];
  log.section(`${sys.name} [${i + 1}/${systems.length}]`);

  // Build credentials from env
  const creds = {
    url:  sys.url  || process.env[sys.urlEnv]  || '',
    user: sys.user || process.env[sys.userEnv] || '',
    pass:            process.env[sys.passEnv]  || '',
  };

  if (!creds.url) {
    log.warn(sys.id, 'Пропуск — URL не настроен в .env', { envVar: sys.urlEnv });
    systemResults.push({
      ...sys, cameras: [], screenshotPath: null,
      error: 'URL не настроен', aiSummary: '',
    });
    continue;
  }

  log.debug(sys.id, 'Credentials', {
    url: creds.url,
    user: creds.user,
    passSet: creds.pass ? 'yes' : 'NO',
  });

  const result = {
    id: sys.id,
    name: sys.name,
    cameras: [],
    screenshotPath: null,
    error: null,
    aiSummary: '',
  };

  // ── Шаг 1: Скриншот ──
  const { screenshotPath, error: shotError } = await captureSystemScreenshot(sys, creds);

  if (shotError) {
    result.error = shotError;
    result.cameras = Array.from({ length: sys.cameraCount || 1 }, (_, i) => ({
      index: i, online: 'unknown', recording: 'unknown', audio: 'unknown',
      notes: `Скриншот не получен: ${shotError}`,
    }));
    systemResults.push(result);
    continue;
  }

  result.screenshotPath = screenshotPath;

  // ── Шаг 2: AI анализ ──
  const { cameras, summary, error: aiError } = await analyzeScreenshot(
    screenshotPath, sys.type, sys.id
  );

  result.aiSummary = summary;

  // Merge AI results with known camera list
  const knownCameras = sys.cameras || Array.from(
    { length: sys.cameraCount || cameras.length }, (_, i) => ({ index: i })
  );

  result.cameras = knownCameras.map(known => {
    const ai = cameras.find(c => c.index === known.index) || {};
    return {
      index: known.index,
      name:  known.name || `Камера ${known.index + 1}`,
      online:    ai.online    ?? 'unknown',
      recording: ai.recording ?? 'unknown',
      audio:     ai.audio     ?? 'unknown',
      notes:     ai.notes     || (aiError ? 'AI анализ не выполнен' : ''),
    };
  });

  systemResults.push(result);
}

// ─── Build report ─────────────────────────────────────────────────────────────
log.section('Формирование отчёта');
const durationMs = Date.now() - startTime;
const reportPath = buildReport({ systemResults, runMeta: { startTime, durationMs } });
log.info('report', 'HTML-отчёт сохранён', { path: reportPath });

// ─── Count issues ─────────────────────────────────────────────────────────────
const issueCount = systemResults.reduce((sum, sys) => {
  if (sys.error) return sum + 1;
  return sum + sys.cameras.filter(c => c.online === false || c.recording === false).length;
}, 0);

if (issueCount > 0) {
  log.warn('report', `Обнаружено проблем: ${issueCount}`);
} else {
  log.info('report', 'Проблем не обнаружено');
}

// ─── Send email ───────────────────────────────────────────────────────────────
const screenshotPaths = systemResults.map(s => s.screenshotPath).filter(Boolean);

if (!isDryRun) {
  log.stepStart('email', 'Отправка email', { to: process.env.REPORT_TO });
  try {
    await sendReport({ reportPath, issueCount, runTime: startTime, screenshotPaths });
    log.stepEnd('email', 'ok', 'Email отправлен');
  } catch (err) {
    log.stepEnd('email', 'fail', 'Email не отправлен', { error: err.message });
    process.exit(1);
  }
} else {
  log.info('email', 'DRY-RUN: email не отправлен', { issues: issueCount });
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────
cleanOldScreenshots(3);
cleanOldReports(30);
log.cleanOldLogs(90);

// ─── Итог ─────────────────────────────────────────────────────────────────────
const totalSec = Math.round((Date.now() - startTime) / 1000);
log.section('Готово');
log.info('done', 'Запуск завершён', {
  duration: `${totalSec}s`,
  systems: systemResults.length,
  issues: issueCount,
  report: path.basename(reportPath),
});

process.exit(0);
