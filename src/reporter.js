/**
 * reporter.js — Builds HTML report and sends it via email.
 */

import fs from 'fs';
import path from 'path';
import nodemailer from 'nodemailer';

const ROOT = path.resolve('.');
const REPORTS_DIR = path.join(ROOT, 'reports');

/**
 * Builds and saves an HTML report.
 *
 * @param {object} params
 * @param {Array}  params.systemResults  - per-system results
 * @param {object} params.runMeta        - { startTime, durationMs }
 * @returns {string} absolute path to saved HTML file
 */
export function buildReport({ systemResults, runMeta }) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const ts = new Date(runMeta.startTime)
    .toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const reportPath = path.join(REPORTS_DIR, `report-${ts}.html`);
  const runDate = new Date(runMeta.startTime).toLocaleString('ru-RU');
  const durationSec = Math.round((runMeta.durationMs || 0) / 1000);
  const durationMin = Math.floor(durationSec / 60);
  const durationRemSec = durationSec % 60;

  // Aggregate totals
  let totalCams = 0, totalOnline = 0, totalOffline = 0, totalUnknown = 0;
  const allIssues = [];

  for (const sys of systemResults) {
    for (const cam of sys.cameras) {
      totalCams++;
      if (cam.online === true) totalOnline++;
      else if (cam.online === false) { totalOffline++; allIssues.push({ sys, cam }); }
      else totalUnknown++;
      if (cam.recording === false) allIssues.push({ sys, cam, issue: 'not_recording' });
    }
    if (sys.error) allIssues.push({ sys, cam: null, issue: 'system_error' });
  }

  const icon = (val) => {
    if (val === true)  return '<span class="ok">&#10004;</span>';
    if (val === false) return '<span class="err">&#10008;</span>';
    return '<span class="unk">?</span>';
  };

  // Alerts section
  const alertRows = [...new Map(
    allIssues.map(i => [i.sys.id + (i.cam?.index ?? 'sys'), i])
  ).values()].map(({ sys, cam, issue }) => {
    if (!cam) {
      return `<tr class="row-err"><td colspan="4"><strong>${sys.name}</strong> — Ошибка: ${sys.error}</td></tr>`;
    }
    const issueText = issue === 'not_recording'
      ? 'Запись не идёт'
      : 'Камера offline';
    return `<tr class="row-err">
      <td>${sys.name}</td>
      <td>Камера ${cam.index + 1}</td>
      <td>${issueText}</td>
      <td>${cam.notes || ''}</td>
    </tr>`;
  }).join('\n');

  // Per-system sections
  const systemSections = systemResults.map(sys => {
    const shotHtml = sys.screenshotPath && fs.existsSync(sys.screenshotPath)
      ? `<img src="data:image/png;base64,${fs.readFileSync(sys.screenshotPath).toString('base64')}"
           style="max-width:100%;border:1px solid #334155;border-radius:6px;margin:8px 0;" />`
      : '<p style="color:#64748b">Скриншот недоступен</p>';

    const onlineCount = sys.cameras.filter(c => c.online === true).length;
    const total = sys.cameras.length;

    const camRows = sys.cameras.map(cam => `
      <tr>
        <td>Камера ${cam.index + 1}</td>
        <td>${icon(cam.online)}</td>
        <td>${icon(cam.recording)}</td>
        <td>${icon(cam.audio)}</td>
        <td style="font-size:0.8em;color:#94a3b8">${cam.notes || ''}</td>
      </tr>`).join('\n');

    const errorHtml = sys.error
      ? `<p style="color:#f97316">&#9888; Ошибка: ${sys.error}</p>`
      : '';

    const summaryHtml = sys.aiSummary
      ? `<p style="color:#94a3b8;font-size:0.85em;margin:4px 0">${sys.aiSummary}</p>`
      : '';

    return `
    <div class="system-block">
      <h2>${sys.name} <span class="badge ${onlineCount === total ? 'badge-ok' : 'badge-warn'}">${onlineCount}/${total} online</span></h2>
      ${errorHtml}
      ${summaryHtml}
      ${shotHtml}
      ${total > 0 ? `<table>
        <tr><th>Камера</th><th>Online</th><th>Запись</th><th>Звук</th><th>Примечания</th></tr>
        ${camRows}
      </table>` : ''}
    </div>`;
  }).join('\n');

  const issueCount = allIssues.length;
  const statusColor = issueCount === 0 ? '#22c55e' : '#ef4444';

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<title>AutoCamera ${runDate}</title>
<style>
  body { font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0; margin:0; padding:20px; }
  h1   { color:#f8fafc; margin-bottom:4px; }
  h2   { color:#94a3b8; font-size:1rem; margin:28px 0 8px; border-bottom:1px solid #1e293b; padding-bottom:6px; }
  .meta { color:#64748b; font-size:0.85rem; margin-bottom:20px; }
  .summary { display:flex; gap:14px; flex-wrap:wrap; margin-bottom:24px; }
  .badge-block { background:#1e293b; border-radius:8px; padding:12px 20px; text-align:center; }
  .badge-block .num { font-size:2rem; font-weight:700; }
  .badge-block .lbl { font-size:0.75rem; color:#64748b; }
  .green { color:#22c55e; } .red { color:#ef4444; } .orange { color:#f97316; }
  .ok  { color:#22c55e; font-size:1.1em; }
  .err { color:#ef4444; font-size:1.1em; }
  .unk { color:#64748b; }
  table { border-collapse:collapse; width:100%; margin:8px 0 16px; }
  th { background:#1e293b; padding:8px 12px; text-align:left; font-size:0.8rem; color:#94a3b8; }
  td { padding:8px 12px; border-top:1px solid #1e293b; }
  .row-err td { background:#3b0d0d; }
  .badge { font-size:0.75rem; padding:2px 8px; border-radius:12px; font-weight:600; margin-left:8px; }
  .badge-ok   { background:#14532d; color:#4ade80; }
  .badge-warn { background:#431407; color:#fb923c; }
  .system-block { margin-bottom:32px; }
  .alerts { background:#1a0a0a; border:1px solid #7f1d1d; border-radius:8px; padding:16px; margin-bottom:24px; }
  .alerts h2 { color:#f87171; margin-top:0; border-bottom-color:#7f1d1d; }
  footer { margin-top:32px; font-size:0.75rem; color:#475569; border-top:1px solid #1e293b; padding-top:16px; }
</style>
</head>
<body>
<h1>AutoCamera Monitor</h1>
<div class="meta">
  Запуск: ${runDate} &nbsp;|&nbsp;
  Длительность: ${durationMin}м ${durationRemSec}с &nbsp;|&nbsp;
  <span style="color:${statusColor}">Проблем: ${issueCount}</span>
</div>

<div class="summary">
  <div class="badge-block"><div class="num">${totalCams}</div><div class="lbl">Всего камер</div></div>
  <div class="badge-block"><div class="num green">${totalOnline}</div><div class="lbl">Online</div></div>
  <div class="badge-block"><div class="num red">${totalOffline}</div><div class="lbl">Offline</div></div>
  <div class="badge-block"><div class="num orange">${totalUnknown}</div><div class="lbl">Неизвестно</div></div>
</div>

${issueCount > 0 ? `<div class="alerts">
  <h2>&#9888; Проблемы (${issueCount})</h2>
  <table>
    <tr><th>Система</th><th>Камера</th><th>Проблема</th><th>Примечание</th></tr>
    ${alertRows}
  </table>
</div>` : '<div style="color:#22c55e;margin-bottom:24px;font-size:1.1em">&#10004; Все камеры работают нормально</div>'}

${systemSections}

<footer>Отчёт: ${reportPath}</footer>
</body>
</html>`;

  fs.writeFileSync(reportPath, html, 'utf8');
  return reportPath;
}

/**
 * Sends the HTML report via SMTP.
 *
 * @param {object} params
 * @param {string} params.reportPath
 * @param {number} params.issueCount
 * @param {number} params.runTime
 * @param {Array}  params.screenshotPaths - list of screenshot file paths for attachments
 */
export async function sendReport({ reportPath, issueCount, runTime, screenshotPaths = [] }) {
  const html = fs.readFileSync(reportPath, 'utf8');
  const dateStr = new Date(runTime).toISOString().slice(0, 16).replace('T', ' ');
  const subject = `[AutoCamera] ${dateStr} — ${issueCount} проблем${issueCount === 1 ? 'а' : issueCount >= 2 && issueCount <= 4 ? 'ы' : ''}`;

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const attachments = screenshotPaths
    .filter(p => p && fs.existsSync(p))
    .map(p => ({ filename: path.basename(p), path: p }));

  const recipients = (process.env.REPORT_TO || '')
    .split(',').map(e => e.trim()).filter(Boolean);

  await transporter.sendMail({
    from: process.env.REPORT_FROM,
    to: recipients.join(', '),
    subject,
    html,
    attachments,
  });
}

/**
 * Deletes HTML report files older than N days.
 * @param {number} days
 */
export function cleanOldReports(days) {
  const cutoff = Date.now() - days * 86400_000;
  if (!fs.existsSync(REPORTS_DIR)) return;
  for (const file of fs.readdirSync(REPORTS_DIR)) {
    if (!file.endsWith('.html')) continue;
    const fullPath = path.join(REPORTS_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}
