/**
 * manage-gray.mjs — CLI для управления "серыми" (не отслеживаемыми) камерами.
 *
 * Использует механизмы:
 *   • TRASSIR  → sys.knownOffline (массив displayName) + sync sys.helpdeskIgnore
 *   • Остальные → sys.unusedChannels (массив номеров каналов = index+1)
 *
 * Команды (все вызываются из menu.ps1):
 *   list-systems
 *     Вывод: <sysId>|<sysName>|<grayCount>|<totalCount>  по одной строке на систему.
 *
 *   list <sysId>
 *     Вывод: <position>|<label>|<status>|<kind>          по одной строке на камеру.
 *     position — порядковый номер в списке (1..N), используется для toggle.
 *     status   — gray | active.
 *     kind     — name (TRASSIR, ключ — displayName) | channel (номер канала).
 *
 *   toggle <sysId> <position>
 *     Переключает статус камеры. Сохраняет config/systems.json.
 *     Вывод: grayed|<label>  или  activated|<label>.
 */

import fs from 'fs';
import path from 'path';

const cmd    = process.argv[2];
const sysId  = process.argv[3];
const target = process.argv[4];

const configPath = path.resolve('config', 'systems.json');

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}
function saveConfig(c) {
  fs.writeFileSync(configPath, JSON.stringify(c, null, 2));
}

// Унифицированная сортировка имён вида "201", "210", "RTSP3"
const cmpNames = (a, b) =>
  String(a).localeCompare(String(b), 'ru', { numeric: true, sensitivity: 'base' });

/**
 * Возвращает массив объектов вида { position, label, key, status, kind }
 * для всех камер системы. Используется и для list, и для toggle.
 */
function getItems(sys) {
  // ── TRASSIR: список из cameraGuids, серость через knownOffline ──
  if (sys.id === 'trassir') {
    const guids = sys.cameraGuids || {};
    const names = Object.values(guids).filter(Boolean).slice().sort(cmpNames);
    const offline = sys.knownOffline || [];
    return names.map((name, i) => ({
      position: i + 1,
      label: name,
      key: name,
      status: offline.includes(name) ? 'gray' : 'active',
      kind: 'name',
    }));
  }

  // ── Остальные: cameras[] / channels[] / maxChannelId, серость через unusedChannels ──
  const unused = sys.unusedChannels || [];
  let cams;

  if (Array.isArray(sys.cameras) && sys.cameras.length > 0) {
    cams = sys.cameras.map((c, i) => ({
      ch: (c.index ?? i) + 1,
      label: c.name || `Канал ${(c.index ?? i) + 1}`,
    }));
  } else if (Array.isArray(sys.channels) && sys.channels.length > 0) {
    cams = sys.channels.map((c, i) => ({
      ch: (c.index ?? i) + 1,
      label: c.name || `Канал ${(c.index ?? i) + 1}`,
    }));
  } else if (Number.isInteger(sys.maxChannelId) && sys.maxChannelId > 0) {
    cams = [];
    for (let i = 1; i <= sys.maxChannelId; i++) {
      cams.push({ ch: i, label: `Камера ${i}` });
    }
  } else {
    return [];
  }

  // Сортируем по номеру канала (на всякий)
  cams.sort((a, b) => a.ch - b.ch);

  return cams.map((c, i) => ({
    position: i + 1,
    label: c.label,
    key: c.ch,
    status: unused.includes(c.ch) ? 'gray' : 'active',
    kind: 'channel',
  }));
}

// ─── Команды ──────────────────────────────────────────────────────────────────

if (cmd === 'list-systems') {
  const config = loadConfig();
  for (const sys of config) {
    const items = getItems(sys);
    const gray  = items.filter(it => it.status === 'gray').length;
    console.log(`${sys.id}|${sys.name}|${gray}|${items.length}`);
  }
  process.exit(0);
}

if (cmd === 'list') {
  const config = loadConfig();
  const sys = config.find(s => s.id === sysId);
  if (!sys) {
    console.error(`Система не найдена: ${sysId}`);
    process.exit(1);
  }
  const items = getItems(sys);
  for (const it of items) {
    console.log(`${it.position}|${it.label}|${it.status}|${it.kind}`);
  }
  process.exit(0);
}

if (cmd === 'toggle') {
  const config = loadConfig();
  const sys = config.find(s => s.id === sysId);
  if (!sys) {
    console.error(`Система не найдена: ${sysId}`);
    process.exit(1);
  }

  const items = getItems(sys);
  const pos = parseInt(target, 10);
  const item = items.find(it => it.position === pos);
  if (!item) {
    console.error(`Нет камеры с позицией ${pos}`);
    process.exit(1);
  }

  if (item.kind === 'name') {
    // TRASSIR: меняем knownOffline + синхронизируем helpdeskIgnore
    const list = Array.isArray(sys.knownOffline) ? sys.knownOffline.slice() : [];
    const idx = list.indexOf(item.key);
    let result;
    if (idx >= 0) {
      list.splice(idx, 1);
      result = 'activated';
    } else {
      list.push(item.key);
      list.sort(cmpNames);
      result = 'grayed';
    }
    sys.knownOffline = list;
    sys.helpdeskIgnore = list.slice();
    saveConfig(config);
    console.log(`${result}|${item.label}`);
    process.exit(0);
  } else {
    // Остальные: меняем unusedChannels (массив номеров)
    const list = Array.isArray(sys.unusedChannels) ? sys.unusedChannels.slice() : [];
    const idx = list.indexOf(item.key);
    let result;
    if (idx >= 0) {
      list.splice(idx, 1);
      result = 'activated';
    } else {
      list.push(item.key);
      list.sort((a, b) => a - b);
      result = 'grayed';
    }
    sys.unusedChannels = list;
    saveConfig(config);
    console.log(`${result}|${item.label}`);
    process.exit(0);
  }
}

console.error(`Неизвестная команда: ${cmd}`);
process.exit(2);
