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

import { buildReport, sendReport, cleanOldReports, REPORT_GROUPS, collectBrokenCameras, sendHelpdeskReport } from './reporter.js';
import { fetchHikvisionStatus } from './isapi.js';
import { checkCamerasByRtsp } from './rtsp-check.js';
import { checkTrassirSystem } from './trassir-check.js';
import { checkBewardSystem } from './beward-check.js';
import { checkRecordingsSystem } from './recordings-check.js';
import { checkHikvisionMultiSystem } from './hikvision-multi.js';
import { checkRostelecomSystem } from './rostelecom-check.js';

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

// ─── TEST_MODE banner (v2 dev environment) ──────────────────────────────────
// Печатается, если в .env установлено TEST_MODE=true.
// Защита от случайного запуска прод-конфига в тестовой папке: показывает,
// какие реально адреса используются как получатели.
if (process.env.TEST_MODE === 'true') {
  const truncate = (s, n = 80) => (s || '').length > n ? (s.slice(0, n) + '…') : (s || '(пусто)');
  const banner = [
    '',
    '╔══════════════════════════════════════════════════════════════════════╗',
    '║                    *** TEST MODE — v2 DEV ENV ***                    ║',
    '║                                                                      ║',
    '║  Это тестовая среда AutoCamera. Письма уходят только на              ║',
    '║  тестовые адреса (см. ниже). Helpdesk при пустом HELPDESK_TO         ║',
    '║  отключён.                                                           ║',
    '╠══════════════════════════════════════════════════════════════════════╣',
    `║  REPORT_TO_EVROPLAST: ${truncate(process.env.REPORT_TO_EVROPLAST, 47).padEnd(47)}║`,
    `║  REPORT_TO_ONLINE:    ${truncate(process.env.REPORT_TO_ONLINE, 47).padEnd(47)}║`,
    `║  REPORT_TO (fallback):${truncate(process.env.REPORT_TO, 47).padEnd(47)}║`,
    `║  HELPDESK_TO:         ${truncate(process.env.HELPDESK_TO, 47).padEnd(47)}║`,
    `║  YANDEX_DISK_ROOT:    ${truncate(process.env.YANDEX_DISK_ROOT, 47).padEnd(47)}║`,
    '╚══════════════════════════════════════════════════════════════════════╝',
    '',
  ].join('\n');
  console.log(banner);
  log.info('test-mode', 'TEST_MODE активен — все письма идут на тестовые адреса');
}

// ─── Load systems config ──────────────────────────────────────────────────────
const ROOT = path.resolve('.');
const systemsConfig = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'systems.json'), 'utf8')
);

// ─── Ensure directories ───────────────────────────────────────────────────────
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
});

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

  if (!creds.url && !['ipanda-rtsp', 'trassir-sdk', 'beward-smb', 'smb-recordings', 'hikvision-multi', 'rt-portal'].includes(sys.type)) {
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
    group: sys.group || '',
    unusedChannels: Array.isArray(sys.unusedChannels) ? sys.unusedChannels : [],
    helpdeskIgnore: Array.isArray(sys.helpdeskIgnore) ? sys.helpdeskIgnore : [],
    displayMode: sys.displayMode || 'table',
    gridColumns: sys.gridColumns || 5,
    cameras: [],
    screenshotPath: null,
    error: null,
    aiSummary: '',
  };

  // ── Hikvision/HiWatch: используем ISAPI ──
  if (sys.type === 'hiwatch' || sys.type === 'hikvision') {
    const baseUrl = creds.url.replace(/\/doc\/page\/login\.asp.*/, '').replace(/\/$/, '');
    const { cameras: isapiCams, error: isapiError } = await fetchHikvisionStatus(
      baseUrl, creds.user, creds.pass, { maxChannelId: sys.maxChannelId }
    );

    if (isapiError) {
      result.error = isapiError;
      result.cameras = Array.from({ length: sys.cameraCount || 1 }, (_, i) => ({
        index: i, online: 'unknown', recording: 'unknown', audio: 'unknown',
        notes: `ISAPI ошибка: ${isapiError}`,
      }));
    } else {
      result.cameras = isapiCams;
      const online = isapiCams.filter(c => c.online === true).length;
      const offline = isapiCams.filter(c => c.online === false).length;
      result.aiSummary = `ISAPI: ${online} online, ${offline} offline из ${isapiCams.length}`;
    }

    systemResults.push(result);
    continue;
  }

  // ── iPanda (RTSP): проверяем камеры через RTSP DESCRIBE ──
  if (sys.type === 'ipanda-rtsp' && sys.cameras?.length) {
    const { cameras: rtspCams, error: rtspError } = await checkCamerasByRtsp(
      sys.cameras, sys.rtspUser || 'admin', sys.rtspPass || '', sys.id,
      { nvrIp: sys.nvrIp, nvrRtspUser: sys.nvrRtspUser, nvrRtspPass: sys.nvrRtspPass,
        probeVideo: sys.viaNvr || sys.cameras.some(c => c.viaNvr) }
    );

    if (rtspError) {
      result.error = rtspError;
    } else {
      result.cameras = rtspCams;
      const online = rtspCams.filter(c => c.online === true).length;
      const offline = rtspCams.filter(c => c.online === false).length;
      result.aiSummary = `RTSP: ${online} online, ${offline} offline из ${rtspCams.length}`;
    }

    systemResults.push(result);
    continue;
  }

  // ── TRASSIR (SDK HTTP API) ──
  if (sys.type === 'trassir-sdk') {
    const { cameras: trCams, error: trErr } = await checkTrassirSystem({
      id:           sys.id,
      host:         sys.host,
      port:         sys.port || 8080,
      user:         process.env[sys.userEnv] || sys.user,
      pass:         process.env[sys.passEnv] || sys.pass,
      knownOffline: sys.knownOffline || [],
      cameraGuids:  sys.cameraGuids  || {},
    });
    if (trErr) {
      result.error = trErr;
    } else {
      result.cameras = trCams;
      const online  = trCams.filter(c => c.online === true).length;
      const offline = trCams.filter(c => c.online === false).length;
      result.aiSummary = `TRASSIR SDK: ${online} online, ${offline} offline из ${trCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── SMB-папки с записями (Европласт стройка и т.п.) ──
  if (sys.type === 'smb-recordings') {
    const { cameras: recCams, error: recErr } = await checkRecordingsSystem({
      id:           sys.id,
      host:         sys.host,
      shareName:    sys.shareName,
      basePath:     sys.basePath,
      smbUser:      process.env[sys.smbUserEnv] || sys.smbUser,
      smbPass:      process.env[sys.smbPassEnv] || sys.smbPass,
      freshnessMin: sys.freshnessMin || 60,
      channels:     sys.channels || [],
    });
    if (recErr) {
      result.error = recErr;
    } else {
      result.cameras = recCams;
      const online  = recCams.filter(c => c.online === true).length;
      const offline = recCams.filter(c => c.online === false).length;
      result.aiSummary = `Recordings: ${online} ok, ${offline} stale из ${recCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── Несколько одиночных Hikvision-камер (iVMS) ──
  if (sys.type === 'hikvision-multi') {
    const { cameras: hkCams, error: hkErr } = await checkHikvisionMultiSystem({
      id: sys.id,
      cameras: sys.cameras || [],
    });
    if (hkErr) {
      result.error = hkErr;
    } else {
      result.cameras = hkCams;
      const online  = hkCams.filter(c => c.online === true).length;
      const offline = hkCams.filter(c => c.online === false).length;
      result.aiSummary = `iVMS: ${online} online, ${offline} offline из ${hkCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── BEWARD Record Center (SMB-шара записей) ──
  if (sys.type === 'beward-smb') {
    const { cameras: bwCams, error: bwErr } = await checkBewardSystem({
      id:           sys.id,
      host:         sys.host,
      shareName:    sys.shareName,
      smbUser:      process.env[sys.smbUserEnv] || sys.smbUser,
      smbPass:      process.env[sys.smbPassEnv] || sys.smbPass,
      freshnessMin: sys.freshnessMin || 60,
      cameras:      sys.cameras || [],
    });
    if (bwErr) {
      result.error = bwErr;
    } else {
      result.cameras = bwCams;
      const online  = bwCams.filter(c => c.online === true).length;
      const offline = bwCams.filter(c => c.online === false).length;
      result.aiSummary = `BEWARD: ${online} online, ${offline} offline из ${bwCams.length}`;
    }
    systemResults.push(result);
    continue;
  }

  // ── Ростелеком (портал RT + откат на ping) ──
  if (sys.type === 'rt-portal') {
    const portalUrl = process.env[sys.portalUrlEnv] || '';
    const rtUser    = process.env[sys.userEnv] || '';
    const rtPass    = process.env[sys.passEnv] || '';
    const { cameras: rtCams, error: rtErr, method } = await checkRostelecomSystem({
      id: sys.id, portalUrl, user: rtUser, pass: rtPass,
      cameras: sys.cameras || [],
      excludeApiNames: sys.excludeApiNames || [],
      portalRetries: sys.portalRetries || 3,
    });
    if (rtErr) result.error = rtErr;
    result.cameras = rtCams;
    const online  = rtCams.filter(c => c.online === true).length;
    const offline = rtCams.filter(c => c.online === false).length;
    const src = method === 'portal' ? 'Портал РТ' : 'Ping';
    result.aiSummary = `${src}: ${online} online, ${offline} offline из ${rtCams.length}`;
    systemResults.push(result);
    continue;
  }

  // ── Неизвестный тип системы ──
  log.warn(sys.id, `Неизвестный тип системы: ${sys.type}. Пропускаю.`);
  result.error = `Неизвестный тип проверки: ${sys.type}`;
  systemResults.push(result);
}

// ─── Build & send report per group ────────────────────────────────────────────
log.section('Формирование отчётов');
const durationMs = Date.now() - startTime;

// Общий отчёт для браузера (все группы вместе)
const fullReportPath = buildReport({ systemResults, runMeta: { startTime, durationMs } });
log.info('report', 'Полный HTML-отчёт сохранён', { path: fullReportPath });

// Отдельные отчёты по группам (для email)
let totalIssues = 0;
const groupReports = [];
for (const group of REPORT_GROUPS) {
  const groupSystems = systemResults.filter(s => (s.group || '') === group);
  if (groupSystems.length === 0) continue;

  const groupIssues = groupSystems.reduce((sum, sys) => {
    if (sys.error) return sum + 1;
    return sum + sys.cameras.filter(c => c.online === false || c.recording === false).length;
  }, 0);
  totalIssues += groupIssues;

  const reportPath = buildReport({
    systemResults, runMeta: { startTime, durationMs }, group,
  });
  log.info('report', `HTML-отчёт сохранён [${group}]`, { path: reportPath, issues: groupIssues });
  groupReports.push({ group, reportPath, issues: groupIssues });
}

if (totalIssues > 0) {
  log.warn('report', `Обнаружено проблем: ${totalIssues}`);
} else {
  log.info('report', 'Проблем не обнаружено');
}

// ─── Send email per group ─────────────────────────────────────────────────────
let emailFailures = 0;
if (!isDryRun) {
  for (const { group, reportPath, issues } of groupReports) {
    const toEnv = group === 'Европласт' ? process.env.REPORT_TO_EVROPLAST
                : group === 'Онлайн'    ? process.env.REPORT_TO_ONLINE
                : '';
    const to = toEnv || process.env.REPORT_TO || '(не задан)';
    log.stepStart('email', `Отправка email [${group}]`, { to });
    try {
      await sendReport({
        reportPath, issueCount: issues, runTime: startTime,
        screenshotPaths: [], groupLabel: group,
      });
      log.stepEnd('email', 'ok', `Email отправлен [${group}]`);
    } catch (err) {
      // Не валим процесс — отчёт уже сохранён локально, остальные письма
      // должны продолжать отправляться.
      log.stepEnd('email', 'fail', `Email не отправлен [${group}] (отчёт сохранён локально)`, {
        error: err.message, reportPath,
      });
      emailFailures++;
    }
  }
  // Helpdesk-письмо о сломанных камерах
  const brokenCams = collectBrokenCameras(systemResults);
  if (brokenCams.length > 0) {
    log.stepStart('helpdesk', `Отправка helpdesk-письма`, { to: process.env.HELPDESK_TO, broken: brokenCams.length });
    try {
      await sendHelpdeskReport({ brokenCams, runMeta: { startTime, durationMs } });
      log.stepEnd('helpdesk', 'ok', `Helpdesk-письмо отправлено (${brokenCams.length} проблем)`);
    } catch (err) {
      log.stepEnd('helpdesk', 'fail', 'Helpdesk-письмо не отправлено', { error: err.message });
      emailFailures++;
    }
  } else {
    log.info('helpdesk', 'Проблем нет — helpdesk-письмо не отправляется');
  }
} else {
  log.info('email', 'DRY-RUN: email не отправлен', { groups: groupReports.length, issues: totalIssues });
}

const issueCount = totalIssues;

// ─── Cleanup ──────────────────────────────────────────────────────────────────
cleanOldReports(14);
log.cleanOldLogs(14);

// ─── Итог ─────────────────────────────────────────────────────────────────────
const totalSec = Math.round((Date.now() - startTime) / 1000);
log.section('Готово');
log.info('done', 'Запуск завершён', {
  duration: `${totalSec}s`,
  systems: systemResults.length,
  issues: issueCount,
  emailFailures,
  reports: groupReports.map(g => path.basename(g.reportPath)).join(', '),
});

// Если были неудачные отправки — exit 1, чтобы планировщик отметил прогон
// как проблемный. Но отчёты уже сохранены локально в reports/.
process.exit(emailFailures > 0 ? 1 : 0);
