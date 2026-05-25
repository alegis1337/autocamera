/**
 * reporter.js — Builds HTML report and sends it via email.
 */

import fs from 'fs';
import path from 'path';
import dns from 'dns';
import nodemailer from 'nodemailer';
import { randomUUID } from 'crypto';

// На этой VM системный DNS-сервер — 127.0.0.1 (битый локальный резолвер),
// из-за чего dns.resolve4 падает с queryA ETIMEOUT при отправке через nodemailer.
// Принудительно используем публичные DNS.
try { dns.setServers(['1.1.1.1', '8.8.8.8']); } catch {}

/**
 * Извлекает домен из SMTP-пользователя (efremovoe@dc1c.ru → dc1c.ru).
 * Используется для генерации Message-ID.
 */
function senderDomain() {
  const user = process.env.SMTP_USER || '';
  const at = user.indexOf('@');
  return at >= 0 ? user.slice(at + 1) : 'autocamera.local';
}

/**
 * Убирает HTML-теги, оставляя текстовое содержимое — для text/plain версии.
 */
function htmlToPlainText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<th[^>]*>/gi, '\t')
    .replace(/<td[^>]*>/gi, '\t')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#\d+;/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const ROOT = path.resolve('.');
const REPORTS_DIR = path.join(ROOT, 'reports');

// Группы, по которым формируются отдельные письма.
export const REPORT_GROUPS = ['Европласт', 'Онлайн'];

/**
 * Builds and saves an HTML report.
 *
 * @param {object} params
 * @param {Array}  params.systemResults  - per-system results
 * @param {object} params.runMeta        - { startTime, durationMs, runMode,
 *                                          timeline?, timelineSummary? }
 * @param {string} [params.group]        - "Европласт"/"Онлайн" — для email
 * @param {string} [params.outputPath]   - переопределить путь сохранения
 *                                          (используется live-монитором)
 * @param {boolean}[params.liveMode]     - добавить meta-refresh + плашку
 * @param {Map}    [params.snapMap]      - Map<"sysId|camIndex", { src, fresh, ageMs }>:
 *                                          src — это либо "cid:..." (для email),
 *                                          либо относительный путь к JPG (для live.html
 *                                          / browser-отчёта).
 * @returns {string} absolute path to saved HTML file
 */
export function buildReport({ systemResults, runMeta, group, outputPath, liveMode = false, snapMap = null }) {
  const snap = (sysId, camIndex) => snapMap?.get(`${sysId}|${camIndex}`) || null;
  fs.mkdirSync(REPORTS_DIR, { recursive: true });

  // Если задана конкретная группа — фильтруем по ней.
  // Иначе берём все группы из REPORT_GROUPS, или всё (для тестов).
  let filtered;
  if (group) {
    filtered = systemResults.filter(s => (s.group || '') === group);
  } else {
    filtered = systemResults.filter(s => REPORT_GROUPS.includes(s.group || ''));
    if (filtered.length === 0) filtered = systemResults;
  }

  const ts = new Date(runMeta.startTime)
    .toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const groupSlug = group ? `-${group.toLowerCase().replace(/[^a-zа-я0-9]+/gi, '_')}` : '';
  const reportPath = outputPath || path.join(REPORTS_DIR, `report-${ts}${groupSlug}.html`);

  const startDate = new Date(runMeta.startTime);
  const dd = String(startDate.getDate()).padStart(2, '0');
  const mm = String(startDate.getMonth() + 1).padStart(2, '0');
  const yyyy = startDate.getFullYear();
  const dateStr = `${dd}.${mm}.${yyyy}`;

  // "Производство (TRASSIR)" → "Производство"
  const shortSysName = (n) => (n || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

  // "CH10" → "10", "Camera 01" → "1", "IPCamera 02" → "IP2"
  const shortCamLabel = (cam) => {
    const n = cam.name || `${(cam.index ?? 0) + 1}`;
    let m = n.match(/^CH0*(\d+)$/i);          if (m) return m[1];
    m = n.match(/^Camera\s+0*(\d+)$/i);       if (m) return m[1];
    m = n.match(/^IPCamera\s+0*(\d+)$/i);     if (m) return `IP${m[1]}`;
    return n;
  };

  // Канал в списке "не используется"?
  //   • TRASSIR — серость по displayName в sys.knownOffline
  //   • Остальные системы — по номеру канала в sys.unusedChannels (1-based)
  const isUnused = (sys, cam) => {
    if (sys.type === 'trassir-sdk') {
      const known = sys.knownOffline || [];
      if (known.length === 0) return false;
      return known.includes(cam.name);
    }
    const list = sys.unusedChannels || [];
    if (list.length === 0) return false;
    const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
    return list.includes(ch);
  };

  // ── Секция «Не работают камеры» — карточки с миниатюрами last-good ─────────
  // По каждой упавшей камере: фото (или плейсхолдер если last-good нет),
  // имя объекта мелко и имя камеры покрупнее. По 4 карточки в ряд.
  const errorRows = filtered
    .filter(sys => sys.error)
    .map(sys => `<tr><td colspan="4" style="padding:4px 6px;background:#fff5f5;border:1px solid #fed7d7;border-radius:3px;margin:4px 0;font-size:12px;color:#c53030;font-family:Arial,sans-serif;">
        <strong>${shortSysName(sys.name)}:</strong> ошибка проверки — ${sys.error}
      </td></tr>`).join('');

  const offlineCardList = [];
  for (const sys of filtered) {
    if (sys.error) continue;
    for (const cam of sys.cameras) {
      if (cam.online === false && !isUnused(sys, cam)) {
        offlineCardList.push({ sys, cam });
      }
    }
  }

  function renderOfflineCard({ sys, cam }) {
    const sn  = snap(sys.id, cam.index);
    // Фотка квадратом — 130×130 на 4 колонки в ширину 700px (~160 на колонку,
    // 130×130 + 16px padding/border = аккуратно укладывается).
    const sq = 130;
    const imgHtml = sn
      ? `<img src="${sn.src}" alt="" width="${sq}" height="${sq}" style="display:block;border:0;width:100%;height:${sq}px;object-fit:cover;background:#1a202c;">`
      : `<div style="height:${sq}px;background:#1a202c;color:#a0aec0;font-size:11px;display:block;text-align:center;line-height:${sq}px;font-family:Arial,sans-serif;">нет снимка</div>`;
    const camLabel = cam.name || shortCamLabel(cam);
    return `<td valign="top" width="25%" style="padding:3px;">
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #fed7d7;border-radius:4px;overflow:hidden;background:#fff5f5;font-family:Arial,sans-serif;">
        <tr><td style="padding:0;">${imgHtml}</td></tr>
        <tr><td style="padding:4px 6px;">
          <div style="font-size:10px;color:#718096;line-height:1.2;">${shortSysName(sys.name)}</div>
          <div style="font-size:13px;color:#c53030;font-weight:700;line-height:1.3;">${camLabel}</div>
        </td></tr>
      </table>
    </td>`;
  }

  let offlineHtml;
  if (offlineCardList.length === 0 && !errorRows) {
    offlineHtml = '<div class="all-good">&#10004; Все камеры работают штатно.</div>';
  } else {
    const cardsPerRow = 4;
    const rows = [];
    for (let i = 0; i < offlineCardList.length; i += cardsPerRow) {
      const chunk = offlineCardList.slice(i, i + cardsPerRow);
      const tds = chunk.map(renderOfflineCard);
      while (tds.length < cardsPerRow) tds.push('<td width="25%" style="padding:3px;"></td>');
      rows.push(`<tr>${tds.join('')}</tr>`);
    }
    offlineHtml = `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;table-layout:fixed;margin-top:4px;">
      ${errorRows}
      ${rows.join('')}
    </table>`;
  }

  // ── Секция «Запись» — одна общая строка ────────────────────────────────────
  // Не пишет = recording === false при online === true (без неиспользуемых)
  const notRecording = [];
  for (const sys of filtered) {
    if (sys.error) continue;
    for (const c of sys.cameras) {
      if (isUnused(sys, c)) continue;
      if (c.recording === false && c.online === true) {
        notRecording.push(`${shortSysName(sys.name)} — ${shortCamLabel(c)}`);
      }
    }
  }
  const recordingHtml = notRecording.length === 0
    ? '<div class="rec-row">Запись ведётся на всех рабочих камерах.</div>'
    : `<div class="rec-row err">Нет записи: ${notRecording.join(', ')}.</div>`;

  // ── Сетки по системам ───────────────────────────────────────────────────────
  function gridLabel(name) {
    if (!name) return '?';
    const m = name.match(/^Camera\s+0*(\d+)$/i);
    return m ? `CH${m[1]}` : name;
  }

  // Полный отчёт (браузер) — без группы; email — с группой
  const isBrowserReport = !group;

  let lastGroup = null;
  const systemSections = filtered.map(sys => {
    const usedCams = sys.cameras.filter(c => !isUnused(sys, c));
    const onlineCount = usedCams.filter(c => c.online === true).length;
    const activeTotal = usedCams.filter(c => c.online !== null).length;
    const cols = sys.gridColumns || 5;

    const groupName = sys.group || '';
    let groupHeader = '';
    if (groupName && groupName !== lastGroup) {
      groupHeader = `<div style="background:#1a365d;color:#ffffff;font-size:11px;font-weight:700;letter-spacing:0.5px;padding:4px 8px;margin:8px 0 4px;border-radius:3px;font-family:Arial,sans-serif;">${groupName.toUpperCase()}</div>`;
      lastGroup = groupName;
    }

    const errorHtml = sys.error
      ? `<p style="color:#c53030;font-size:12px;margin:4px 0;font-family:Arial,sans-serif;">&#9888; ${sys.error}</p>`
      : '';

    const badgeBg = onlineCount === activeTotal ? '#c6f6d5' : '#fed7d7';
    const badgeFg = onlineCount === activeTotal ? '#276749' : '#c53030';

    // Email-friendly: настоящая HTML-таблица вместо CSS grid (Gmail режет display:grid).
    //
    // Рендер тайла зависит от типа системы:
    //   • SMB-системы (smb-recordings, beward-smb) — записи на диске, не камеры.
    //     Миниатюры не имеют смысла, рендерим v1-стиль: один <td bgcolor>label</td>.
    //   • Unused-канал — просто серый квадрат без надписи.
    //   • Остальные — миниатюра (last-good) сверху + цветной бейдж с label снизу.
    const isSmbSys  = sys.type === 'smb-recordings' || sys.type === 'beward-smb';
    const cellWidth = `${Math.floor(100 / cols)}%`;
    // Высота тайла одинакова для ВСЕХ систем (кроме SMB) — чтобы письмо
    // выглядело единообразно. 100px подобрано по Производству (TRASSIR cols=5),
    // там получается ≈ квадратный тайл. На системах с другим cols высота
    // остаётся 100, а ширина ячейки меняется по cellWidth%.
    const tileHeight = 100;
    const totalTileH = tileHeight + 22;

    const renderCell = (cam) => {
      const isU = isUnused(sys, cam);

      const noRec = cam.online === true && cam.recording === false;
      const bg = isU                  ? '#a0aec0'
               : cam.online === false ? '#e53e3e'
               : noRec                ? '#dd6b20'
               : cam.online === true  ? '#2f855a'
               :                        '#a0aec0';
      const label = gridLabel(cam.name)
                  + (!isU && noRec ? ' <span style="font-size:8px;vertical-align:top;">⚠</span>' : '');

      // SMB-системы (Стройка, BEWARD) — v1-стиль без миниатюры,
      // тайл с label по центру. Высота меньше — там нет миниатюры.
      if (isSmbSys) {
        return `<td width="${cellWidth}" align="center" valign="middle" bgcolor="${bg}" style="height:${totalTileH}px;color:#ffffff;font-weight:700;font-size:12px;border:1px solid #ffffff;line-height:1.2;padding:4px;">${label}</td>`;
      }

      // Все остальные тайлы — единая структура: верхний блок 100px + бейдж снизу.
      //   • Unused → верхний блок просто серый без надписи + серый бейдж снизу
      //   • Без last-good → тёмный плейсхолдер «нет снимка» + цветной бейдж
      //   • С last-good → миниатюра + цветной бейдж
      let topBlock;
      if (isU) {
        topBlock = `<div style="height:${tileHeight}px;background:#a0aec0;"></div>`;
      } else {
        const sn = snap(sys.id, cam.index);
        topBlock = sn
          ? `<img src="${sn.src}" alt="" width="100%" height="${tileHeight}" style="display:block;border:0;width:100%;height:${tileHeight}px;object-fit:cover;background:#1a202c;">`
          : `<div style="height:${tileHeight}px;background:#1a202c;color:#a0aec0;font-size:10px;text-align:center;line-height:${tileHeight}px;font-family:Arial,sans-serif;">нет снимка</div>`;
      }

      return `<td width="${cellWidth}" valign="top" style="padding:1px;border:1px solid #ffffff;">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr><td style="padding:0;">${topBlock}</td></tr>
          <tr><td align="center" bgcolor="${bg}" style="padding:3px 2px;color:#ffffff;font-weight:700;font-size:11px;line-height:1.1;border-top:2px solid #ffffff;">${label}</td></tr>
        </table>
      </td>`;
    };

    const rows = [];
    for (let i = 0; i < sys.cameras.length; i += cols) {
      const chunk = sys.cameras.slice(i, i + cols);
      const tds = chunk.map(renderCell);
      while (tds.length < cols) tds.push(`<td width="${cellWidth}" style="border:1px solid #ffffff;"></td>`);
      rows.push(`<tr>${tds.join('')}</tr>`);
    }
    const gridHtml = sys.cameras.length > 0
      ? `<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background:#ffffff;table-layout:fixed;">${rows.join('')}</table>`
      : '';

    // ── Подробная таблица камер (только для браузерного отчёта) ──
    let detailHtml = '';
    if (isBrowserReport) {
      const problemCams = sys.cameras.filter(c => !isUnused(sys, c) && (c.online === false || c.recording === false || c.online === null));
      const infoCams = sys.cameras.filter(c => !isUnused(sys, c) && c.notes && c.online === true);

      if (problemCams.length > 0 || sys.error) {
        const problemRows = problemCams.map(cam => {
          const status = cam.online === false ? '<span style="color:#e53e3e;font-weight:700;">OFFLINE</span>'
                       : cam.online === null  ? '<span style="color:#a0aec0;">Н/Д</span>'
                       : '<span style="color:#2f855a;">online</span>';
          const rec = cam.recording === false ? '<span style="color:#e53e3e;">нет</span>'
                    : cam.recording === true  ? '<span style="color:#2f855a;">да</span>'
                    : '<span style="color:#a0aec0;">—</span>';
          const reason = cam.notes || 'причина неизвестна';
          return `<tr style="border-bottom:1px solid #e2e8f0;">
            <td style="padding:3px 6px;font-size:11px;vertical-align:top;">${cam.name || gridLabel(cam.name)}</td>
            <td style="padding:3px 6px;font-size:11px;text-align:center;vertical-align:top;">${status}</td>
            <td style="padding:3px 6px;font-size:11px;text-align:center;vertical-align:top;">${rec}</td>
            <td style="padding:3px 6px;font-size:11px;color:#4a5568;vertical-align:top;">${reason}</td>
          </tr>`;
        }).join('');

        detailHtml = `
        <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:2px;font-family:Arial,sans-serif;">
          <tr style="background:#edf2f7;">
            <th style="padding:3px 6px;font-size:10px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
            <th style="padding:3px 6px;font-size:10px;text-align:center;font-weight:600;color:#4a5568;">Статус</th>
            <th style="padding:3px 6px;font-size:10px;text-align:center;font-weight:600;color:#4a5568;">Запись</th>
            <th style="padding:3px 6px;font-size:10px;text-align:left;font-weight:600;color:#4a5568;">Причина / заметки</th>
          </tr>
          ${problemRows}
        </table>`;
      }

      // Краткая сводка по работающим камерам с заметками (запись, возраст и т.п.)
      if (infoCams.length > 0 && infoCams.some(c => c.recording === true || c.recordingAge)) {
        const infoRows = infoCams.filter(c => c.notes).map(cam => {
          const rec = cam.recording === true ? '<span style="color:#2f855a;">да</span>' : '<span style="color:#a0aec0;">—</span>';
          return `<tr style="border-bottom:1px solid #f7fafc;">
            <td style="padding:2px 6px;font-size:10px;">${cam.name || gridLabel(cam.name)}</td>
            <td style="padding:2px 6px;font-size:10px;text-align:center;">${rec}</td>
            <td style="padding:2px 6px;font-size:10px;color:#718096;">${cam.notes}</td>
          </tr>`;
        }).join('');
        if (infoRows) {
          detailHtml += `
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin-top:2px;font-family:Arial,sans-serif;opacity:0.85;">
            <tr style="background:#f7fafc;">
              <th style="padding:2px 6px;font-size:9px;text-align:left;color:#a0aec0;">Камера</th>
              <th style="padding:2px 6px;font-size:9px;text-align:center;color:#a0aec0;">Зап.</th>
              <th style="padding:2px 6px;font-size:9px;text-align:left;color:#a0aec0;">Инфо</th>
            </tr>
            ${infoRows}
          </table>`;
        }
      }
    }

    // Метод проверки (только браузер)
    const methodLabel = isBrowserReport && sys.aiSummary
      ? `<span style="font-size:9px;color:#a0bcc8;margin-left:6px;font-weight:400;">${sys.aiSummary}</span>`
      : '';

    // Ссылка на папку объекта в Битриксе была убрана — теперь снимки видны
    // прямо в отчёте как миниатюры в гриде.

    return `${groupHeader}
    <div style="margin-bottom:8px;border:1px solid #e2e8f0;border-radius:3px;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="background:#2c5282;color:#ffffff;font-size:12px;font-weight:700;padding:5px 10px;">
        ${shortSysName(sys.name)}
        <span style="font-size:10px;padding:1px 7px;border-radius:9px;font-weight:600;margin-left:6px;background:${badgeBg};color:${badgeFg};">${onlineCount}/${activeTotal} online</span>
        ${methodLabel}
      </div>
      ${errorHtml}
      ${gridHtml}
      ${detailHtml}
    </div>`;
  }).join('\n');

  // ── Секция «История за день» — рисуется в самом низу отчёта.
  // Колонки: Объект | Камера | Падений | Не работала с HH:MM до HH:MM
  // Если интервалов несколько — соединяем через "; "
  let historyHtml = '';
  {
    const summary = Array.isArray(runMeta.timelineSummary) ? runMeta.timelineSummary : [];
    const filteredSummary = group
      ? summary.filter(r => filtered.some(s => s.id === r.systemId))
      : summary;

    if (filteredSummary.length > 0) {
      const rowsHtml = filteredSummary.map(r => {
        // Собираем периоды: "08:15 — 09:02; 11:40 — сейчас"
        const periodText = (r.intervals || []).map(iv => {
          if (iv.ongoing) return `${iv.from} — сейчас`;
          return `${iv.from} — ${iv.to}`;
        }).join('; ') || '—';

        const stateColor = r.currentlyDown ? '#c53030' : '#4a5568';
        return `<tr style="border-bottom:1px solid #e2e8f0;">
          <td style="padding:4px 8px;font-size:12px;color:#2c5282;font-weight:600;vertical-align:top;white-space:nowrap;">${shortSysName(r.system)}</td>
          <td style="padding:4px 8px;font-size:12px;color:#1a202c;vertical-align:top;">${r.camera}</td>
          <td style="padding:4px 8px;font-size:12px;color:#4a5568;text-align:center;vertical-align:top;">${r.incidents}</td>
          <td style="padding:4px 8px;font-size:12px;color:${stateColor};vertical-align:top;">${periodText}</td>
        </tr>`;
      }).join('');

      historyHtml = `
<div class="section-title">История за день</div>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-bottom:12px;">
  <tr style="background:#edf2f7;">
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Объект</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Камера</th>
    <th style="padding:4px 8px;font-size:11px;text-align:center;font-weight:600;color:#4a5568;">Падений</th>
    <th style="padding:4px 8px;font-size:11px;text-align:left;font-weight:600;color:#4a5568;">Не работала</th>
  </tr>
  ${rowsHtml}
</table>`;
    }
  }

  // Live-режим: meta-refresh каждые 30с, плашка над содержимым,
  // другой title (видно в табе браузера).
  const liveTimeStr = startDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const liveMetaTag = liveMode
    ? '<meta http-equiv="refresh" content="30">'
    : '';
  const liveBannerHtml = liveMode
    ? `<div style="background:#1a365d;color:#ffffff;padding:8px 14px;border-radius:4px;font-size:13px;margin-bottom:12px;font-family:Arial,sans-serif;">
         &#10227; <strong>Live-монитор</strong> — обновлено в ${liveTimeStr}, страница перезагрузится автоматически каждые 30 сек
       </div>`
    : '';
  const titleStr = liveMode
    ? `AutoCamera Live (${liveTimeStr})`
    : `Отчёт по видеонаблюдению ${dateStr}`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
${liveMetaTag}
<title>${titleStr}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; background:#ffffff; color:#1a202c; margin:0; padding:18px; max-width:720px; line-height:1.5; }
  .greeting { font-size:1rem; margin-bottom:6px; }
  .lead     { font-size:1.05rem; margin:6px 0 18px; font-weight:600; color:#1a365d; }
  .section-title { font-size:1rem; font-weight:700; color:#1a365d; margin:18px 0 6px; border-bottom:2px solid #1a365d; padding-bottom:3px; }
  .off-row  { padding:4px 0; font-size:0.95rem; }
  .off-sys  { font-weight:700; color:#2c5282; }
  .off-err  { color:#c53030; }
  .all-good { color:#276749; font-size:0.95rem; padding:4px 0; }
  .rec-row  { padding:4px 0; font-size:0.95rem; }
  .rec-row.err { color:#c53030; }
  .rec-sys  { font-weight:700; color:#2c5282; }

  /* Сетки систем */
  .systems-wrap { font-family: system-ui, Arial, sans-serif; margin-top:18px; }
  .system-block { margin-bottom:10px; border:1px solid #e2e8f0; border-radius:4px; overflow:hidden; }
  .group-header { background:#1a365d; color:#ffffff; font-size:0.85rem; font-weight:700; letter-spacing:0.6px; padding:7px 12px; border-radius:4px; margin:14px 0 6px; }
  .system-head  { background:#2c5282; color:#ffffff; font-size:0.82rem; font-weight:700; padding:6px 10px; }
  .badge { font-size:0.68rem; padding:2px 8px; border-radius:10px; font-weight:600; margin-left:6px; vertical-align:middle; }
  .badge-ok   { background:#c6f6d5; color:#276749; }
  .badge-warn { background:#fed7d7; color:#c53030; }
  .cam-grid { display:grid; gap:4px; padding:6px; background:#ffffff; }
  .cam-cell { padding:9px 4px; text-align:center; border-radius:3px; font-weight:700; font-size:0.78rem; line-height:1.1; color:#ffffff; }
  .cam-on  { background:#2f855a; }
  .cam-off { background:#e53e3e; }
  .cam-unk { background:#a0aec0; font-weight:500; }

  .signature { margin-top:28px; padding-top:14px; border-top:1px solid #e2e8f0; font-size:0.95rem; line-height:1.5; }
  .signature .name { font-weight:700; }
  .signature .company { font-style:italic; color:#4a5568; }
</style>
</head>
<body>

${liveBannerHtml}
${liveMode ? '' : '<div class="greeting">Добрый день!</div>'}
<div class="lead">${liveMode ? 'AutoCamera Live — статус видеонаблюдения' : `Отчёт по видеонаблюдению на ${dateStr}`}</div>
${isBrowserReport ? `<div style="font-size:0.8rem;color:#718096;margin-bottom:12px;">Проверка: ${new Date(runMeta.startTime).toLocaleTimeString('ru-RU')} | Длительность: ${Math.round(runMeta.durationMs / 1000)} сек | Систем: ${filtered.length}</div>` : ''}

<div class="section-title">Не работают камеры</div>
${offlineHtml}

<div class="section-title">Запись</div>
${recordingHtml}

<div class="systems-wrap" style="max-width:${isBrowserReport ? '720' : '520'}px;">
${systemSections}
</div>

${historyHtml}

<div class="section-title" style="margin-top:18px;">Обозначения в сетках камер</div>
<table cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;font-family:Arial,sans-serif;margin-top:6px;">
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#2f855a;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">зелёный — камера онлайн, передаёт видео</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#e53e3e;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">красный — камера офлайн, не передаёт видео или нет сигнала</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#dd6b20;border:1px solid #ffffff;vertical-align:middle;text-align:center;color:#ffffff;font-weight:700;font-size:9px;line-height:14px;">⚠</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">оранжевый со знаком ⚠ — картинка есть, но записи нет (или запись устарела)</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;width:14px;height:14px;background:#a0aec0;border:1px solid #ffffff;vertical-align:middle;"></span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">серый — канал не используется или статус неизвестен</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;padding:1px 7px;background:#c6f6d5;color:#276749;border-radius:9px;font-size:10px;font-weight:600;font-family:Arial,sans-serif;">N/N online</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">зелёный бейдж — все камеры системы работают</td>
  </tr>
  <tr>
    <td style="padding:3px 8px 3px 0;vertical-align:middle;">
      <span style="display:inline-block;padding:1px 7px;background:#fed7d7;color:#c53030;border-radius:9px;font-size:10px;font-weight:600;font-family:Arial,sans-serif;">N/M online</span>
    </td>
    <td style="padding:3px 16px 3px 4px;font-size:12px;color:#2d3748;vertical-align:middle;">красный бейдж — часть камер в системе не работает</td>
  </tr>
</table>

<div class="signature">
С уважением,<br>
специалист технической поддержки<br><br>
<span class="name">Ефремов Олег</span><br>
<span class="company">ГК «Цифровая Сибирь»</span><br>
+7 906 916-08-80
</div>


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
export async function sendReport({ reportPath, issueCount, runTime, screenshotPaths = [], groupLabel = '', inlineImages = [] }) {
  const html = fs.readFileSync(reportPath, 'utf8');
  const d = new Date(runTime);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const labelPart = groupLabel ? ` (${groupLabel})` : '';
  const subject = `Отчет по видеонаблюдению${labelPart} — ${dd}.${mm}.${yyyy}`;

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true';

  // На этой VM системный DNS-резолвер сломан (127.0.0.1 не отвечает на queryA),
  // поэтому nodemailer/c-ares не может зарезолвить хост сам.
  // Резолвим через dns.lookup (использует ОС-резолвер, работает) и передаём
  // готовый IP, а имя хоста — в tls.servername для корректного SNI.
  const lookup = (host) => new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, addr) => err ? reject(err) : resolve(addr));
  });
  const smtpIp = await lookup(smtpHost);

  const transporter = nodemailer.createTransport({
    host: smtpIp,
    port: smtpPort,
    secure: smtpSecure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: { servername: smtpHost },
  });

  const attachments = screenshotPaths
    .filter(p => p && fs.existsSync(p))
    .map(p => ({ filename: path.basename(p), path: p }));

  // Inline-вложения для CID-картинок (миниатюр камер в отчёте). Файлы
  // лежат локально (screenshots/last-good/...) — путь не уйдёт получателю,
  // nodemailer прикрепит их как multipart/related с теми же cid'ами,
  // которые указаны в src="cid:..." внутри HTML.
  for (const img of inlineImages) {
    if (!img || !img.path || !img.cid) continue;
    if (!fs.existsSync(img.path)) continue;
    attachments.push({
      filename: path.basename(img.path),
      path:     img.path,
      cid:      img.cid,
      contentDisposition: 'inline',
    });
  }

  // Группа-специфичные адресаты. Если для группы не заданы —
  // используем общий REPORT_TO как фолбэк.
  const groupEnv = groupLabel === 'Европласт' ? process.env.REPORT_TO_EVROPLAST
                 : groupLabel === 'Онлайн'    ? process.env.REPORT_TO_ONLINE
                 : '';
  const rawRecipients = groupEnv || process.env.REPORT_TO || '';
  const recipients = rawRecipients.split(',').map(e => e.trim()).filter(Boolean);

  if (recipients.length === 0) {
    throw new Error(`Не задан адрес получателя для группы "${groupLabel || 'default'}"`);
  }

  const fromAddr = process.env.SMTP_USER;
  const fromDomain = (fromAddr.split('@')[1] || senderDomain()).trim();

  // Строим письмо для конкретного одного получателя.
  const buildMail = (to) => ({
    from: `"AutoCamera Monitor" <${fromAddr}>`,
    // envelope.from — то, что уходит в SMTP MAIL FROM. Должно совпадать с From
    // и быть в том же домене, иначе Яндекс режет как SPAM/Spoof.
    envelope: { from: fromAddr, to: [to] },
    replyTo: fromAddr,
    to,
    subject,
    text: htmlToPlainText(html),
    html,
    attachments,
    // Message-ID в том же домене, что и From — требование Яндекса.
    messageId: `<autocamera-${randomUUID()}@${fromDomain}>`,
    date: new Date(),
    headers: {
      'X-Mailer': 'AutoCamera Monitor/1.0',
      'Auto-Submitted': 'auto-generated',
      'Precedence': 'bulk',
    },
  });

  const sendOneWithRetry = async (to) => {
    const maxAttempts = 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await transporter.sendMail(buildMail(to));
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 60_000));
      }
    }
    throw lastErr;
  };

  // КРИТИЧНО: отправляем каждому получателю ОТДЕЛЬНОЕ письмо.
  // Яндекс часто режет массовые рассылки (несколько To) как SPAM 554 5.7.1,
  // даже если все адреса валидные. Проверено 2026-04-23 — одиночные уходят.
  const failures = [];
  for (const to of recipients) {
    try {
      await sendOneWithRetry(to);
    } catch (err) {
      failures.push({ to, error: err.message });
    }
  }
  if (failures.length > 0) {
    const summary = failures.map(f => `${f.to}: ${f.error}`).join('; ');
    throw new Error(summary);
  }
}

/**
 * Собирает список сломанных камер по всем системам (для helpdesk-письма).
 * Исключает камеры из helpdeskIgnore и неиспользуемые каналы.
 *
 * @param {Array} systemResults — результаты проверки всех систем
 * @returns {Array} [{ systemId, system, group, camera, status, notes }]
 *   systemId — стабильный id системы (для ключа в state.js)
 */
export function collectBrokenCameras(systemResults) {
  const broken = [];

  for (const sys of systemResults) {
    const ignoreList = sys.helpdeskIgnore || [];

    const group = sys.group || 'Прочее';

    // Ошибка всей системы — добавляем как одну запись
    if (sys.error) {
      broken.push({
        systemId: sys.id,
        group,
        system: sys.name,
        camera: '(вся система)',
        status: 'ошибка проверки',
        notes: sys.error,
      });
      continue;
    }

    for (const cam of sys.cameras) {
      // Пропускаем неиспользуемые каналы
      const unusedList = sys.unusedChannels || [];
      const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
      if (unusedList.includes(ch)) continue;

      // Пропускаем камеры из helpdeskIgnore (по имени)
      const camLabel = cam.name || `${ch}`;
      if (ignoreList.some(pattern => camLabel.includes(pattern))) continue;

      // Собираем сломанные: offline или нет записи
      if (cam.online === false) {
        broken.push({
          systemId: sys.id,
          group,
          system: sys.name,
          camera: camLabel,
          status: 'OFFLINE',
          notes: cam.notes || '',
        });
      } else if (cam.recording === false && cam.online === true) {
        broken.push({
          systemId: sys.id,
          group,
          system: sys.name,
          camera: camLabel,
          status: 'нет записи',
          notes: cam.notes || '',
        });
      }
    }
  }

  return broken;
}

/**
 * Форматирует timestamp как "24.04.2026 08:00" (МСК-локаль).
 */
function fmtTs(ts) {
  if (!ts) return '?';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const tt = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${dd}.${mm}.${yyyy} ${tt}`;
}

/**
 * Генерирует HTML-письмо для helpdesk: две таблицы — новые проблемы и
 * восстановленные. Шлётся только при наличии чего-то в любой из них
 * (см. sendHelpdeskReport).
 *
 * @param {Array}  newlyBroken — новые поломки (есть _firstBrokenAt / _statusChanged)
 * @param {Array}  recovered   — восстановленные камеры
 * @param {object} runMeta     — { startTime, durationMs }
 * @param {string} groupLabel  — "Европласт" / "Онлайн" / ""
 */
export function buildHelpdeskDiffHtml(newlyBroken, recovered, runMeta, groupLabel = '') {
  const startDate = new Date(runMeta.startTime);
  const dateStr = fmtTs(runMeta.startTime).slice(0, 10);
  const timeStr = startDate.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const groupHeader = groupLabel
    ? `<div style="background:#1a365d;color:#ffffff;padding:6px 14px;font-size:13px;font-weight:700;letter-spacing:0.6px;border-radius:3px;margin:10px 0;">Проект: ${groupLabel.toUpperCase()}</div>`
    : '';

  // Шапка письма зависит от того, есть ли новые проблемы или это только
  // отчёт о восстановлении.
  const hasNew = newlyBroken.length > 0;
  const hasRecovered = recovered.length > 0;

  const headerBg = hasNew ? '#c53030' : '#276749';
  const headerIcon = hasNew ? '&#9888;' : '&#10004;';
  const headerText = hasNew
    ? 'Изменения статуса камер видеонаблюдения'
    : 'Камеры восстановлены';

  // ── Таблица новых поломок ──
  let newSection = '';
  if (hasNew) {
    const rows = newlyBroken.map(c => {
      const statusColor = c.status === 'OFFLINE' ? '#e53e3e' : '#dd6b20';
      // Если статус сменился — показать "было: X → стало: Y"
      const statusCell = c._statusChanged
        ? `<span style="color:#a0aec0;text-decoration:line-through;font-size:11px;">${c._previousStatus}</span> &#8594; <span style="color:${statusColor};font-weight:700;">${c.status}</span>`
        : `<span style="color:${statusColor};font-weight:700;">${c.status}</span>`;
      return `<tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:6px 10px;font-size:13px;font-weight:600;color:#2c5282;vertical-align:top;">${c.system}</td>
        <td style="padding:6px 10px;font-size:13px;vertical-align:top;">${c.camera}</td>
        <td style="padding:6px 10px;font-size:13px;vertical-align:top;">${statusCell}</td>
        <td style="padding:6px 10px;font-size:12px;color:#4a5568;vertical-align:top;">${c.notes || ''}</td>
      </tr>`;
    }).join('');

    newSection = `
<h3 style="font-size:14px;color:#c53030;margin:18px 0 6px;">
  &#9888; Новые проблемы (${newlyBroken.length}):
</h3>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:6px 0;">
  <tr style="background:#2c5282;color:#ffffff;">
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Система</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Камера</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Статус</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Подробности</th>
  </tr>
  ${rows}
</table>`;
  }

  // ── Таблица восстановленных ──
  let recoveredSection = '';
  if (hasRecovered) {
    const rows = recovered.map(c => {
      const since = fmtTs(c.brokenSince);
      return `<tr style="border-bottom:1px solid #e2e8f0;">
        <td style="padding:6px 10px;font-size:13px;font-weight:600;color:#2c5282;">${c.system}</td>
        <td style="padding:6px 10px;font-size:13px;">${c.camera}</td>
        <td style="padding:6px 10px;font-size:12px;color:#a0aec0;text-decoration:line-through;">${c.previousStatus || ''}</td>
        <td style="padding:6px 10px;font-size:12px;color:#276749;">снова работает (была сломана с ${since})</td>
      </tr>`;
    }).join('');

    recoveredSection = `
<h3 style="font-size:14px;color:#276749;margin:18px 0 6px;">
  &#10004; Восстановлены (${recovered.length}):
</h3>
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:6px 0;">
  <tr style="background:#276749;color:#ffffff;">
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Система</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Камера</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Было</th>
    <th style="padding:8px 10px;font-size:12px;text-align:left;">Стало</th>
  </tr>
  ${rows}
</table>`;
  }

  return `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>Helpdesk — изменения статуса камер ${dateStr}</title></head>
<body style="font-family:Arial,sans-serif;background:#ffffff;color:#1a202c;margin:0;padding:20px;max-width:740px;">

<div style="background:${headerBg};color:#ffffff;padding:12px 18px;border-radius:4px;font-size:16px;font-weight:700;">
  ${headerIcon} ${headerText}
</div>

${groupHeader}

<p style="font-size:14px;color:#4a5568;margin:12px 0;">
  Автоматическая проверка <strong>${dateStr} ${timeStr}</strong>${groupLabel ? ` (проект «${groupLabel}»)` : ''}:
  ${hasNew ? `<strong>${newlyBroken.length}</strong> новых поломок` : ''}${hasNew && hasRecovered ? ', ' : ''}${hasRecovered ? `<strong>${recovered.length}</strong> восстановлено` : ''}.
</p>

${newSection}
${recoveredSection}

<p style="font-size:12px;color:#718096;margin-top:18px;border-top:1px solid #e2e8f0;padding-top:12px;">
  Письмо сформировано автоматически системой AutoCamera Monitor.<br>
  В заявку попадают только <strong>изменения статуса</strong> с прошлого прогона —
  если камера лежит давно, повторная заявка не создаётся.
</p>

</body>
</html>`;
}

/**
 * Старая обёртка — оставлена для обратной совместимости с возможными
 * внешними скриптами. Внутри проекта использовать buildHelpdeskDiffHtml.
 */
export const buildHelpdeskHtml = (brokenCams, runMeta, groupLabel = '') =>
  buildHelpdeskDiffHtml(brokenCams, [], runMeta, groupLabel);

/**
 * Отправляет helpdesk-письмо о новых поломках и восстановлениях.
 * Если в обеих категориях пусто — ничего не шлёт.
 *
 * @param {object} params
 * @param {Array}  params.newlyBroken — результат diffAndUpdate().newlyBroken
 * @param {Array}  params.recovered   — результат diffAndUpdate().recovered
 * @param {object} params.runMeta     — { startTime, durationMs }
 *
 * Совместимость: если передан params.brokenCams (старый API), он трактуется
 * как newlyBroken, а recovered=[] — поведение как раньше.
 */
export async function sendHelpdeskReport({ newlyBroken, recovered, brokenCams, runMeta }) {
  // Совместимость со старым API.
  if (!newlyBroken && Array.isArray(brokenCams)) {
    newlyBroken = brokenCams;
    recovered = [];
  }
  newlyBroken = newlyBroken || [];
  recovered   = recovered   || [];

  const helpdeskTo = (process.env.HELPDESK_TO || '')
    .split(',').map(e => e.trim()).filter(Boolean);
  if (helpdeskTo.length === 0) return;
  if (newlyBroken.length === 0 && recovered.length === 0) return;

  // Группируем по проектам — отдельное письмо на каждую группу.
  const allByGroup = new Map();
  const ensureGroup = (g) => {
    const key = g || 'Прочее';
    if (!allByGroup.has(key)) allByGroup.set(key, { newlyBroken: [], recovered: [] });
    return allByGroup.get(key);
  };
  for (const c of newlyBroken) ensureGroup(c.group).newlyBroken.push(c);
  for (const c of recovered)   ensureGroup(c.group).recovered.push(c);

  const d = new Date(runMeta.startTime);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();

  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true';

  const lookup = (host) => new Promise((resolve, reject) => {
    dns.lookup(host, { family: 4 }, (err, addr) => err ? reject(err) : resolve(addr));
  });
  const smtpIp = await lookup(smtpHost);

  const transporter = nodemailer.createTransport({
    host: smtpIp,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { servername: smtpHost },
  });

  const fromAddr = process.env.SMTP_USER;
  const fromDomain = (fromAddr.split('@')[1] || senderDomain()).trim();

  const buildMail = (to, groupName, payload) => {
    const html = buildHelpdeskDiffHtml(payload.newlyBroken, payload.recovered, runMeta, groupName);
    const parts = [];
    if (payload.newlyBroken.length) parts.push(`${payload.newlyBroken.length} новых`);
    if (payload.recovered.length)   parts.push(`${payload.recovered.length} восстановл.`);
    const subject = `[HELPDESK] ${groupName} — изменения камер ${dd}.${mm}.${yyyy} (${parts.join(', ')})`;
    return {
      from: `"AutoCamera Helpdesk" <${fromAddr}>`,
      envelope: { from: fromAddr, to: [to] },
      replyTo: fromAddr,
      to,
      subject,
      text: htmlToPlainText(html),
      html,
      messageId: `<autocamera-hd-${randomUUID()}@${fromDomain}>`,
      date: new Date(),
      headers: {
        'X-Mailer': 'AutoCamera Monitor/2.0',
        'Auto-Submitted': 'auto-generated',
        'Precedence': 'bulk',
      },
    };
  };

  const sendOneWithRetry = async (to, groupName, payload) => {
    const maxAttempts = 2;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await transporter.sendMail(buildMail(to, groupName, payload));
        return;
      } catch (err) {
        lastErr = err;
        if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 60_000));
      }
    }
    throw lastErr;
  };

  // Каждой группе — каждому получателю отдельное письмо (Яндекс SPAM workaround).
  const failures = [];
  for (const [groupName, payload] of allByGroup) {
    if (payload.newlyBroken.length === 0 && payload.recovered.length === 0) continue;
    for (const to of helpdeskTo) {
      try {
        await sendOneWithRetry(to, groupName, payload);
      } catch (err) {
        failures.push({ to, groupName, error: err.message });
      }
    }
  }
  if (failures.length > 0) {
    const summary = failures.map(f => `${f.groupName} → ${f.to}: ${f.error}`).join('; ');
    throw new Error(summary);
  }
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
    // Live-монитор перезаписывается каждый прогон — не удалять
    if (file === 'live.html') continue;
    const fullPath = path.join(REPORTS_DIR, file);
    if (fs.statSync(fullPath).mtimeMs < cutoff) fs.unlinkSync(fullPath);
  }
}
