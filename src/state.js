/**
 * state.js — Хранение состояния камер между прогонами для дедупликации
 * helpdesk-заявок.
 *
 * Сохраняет каждый объект "сломанная камера" с timestamp первой поломки
 * и последнего наблюдения. По состоянию вычисляются три множества:
 *   newlyBroken — камеры, которые сломались впервые (или сменили причину);
 *   recovered   — камеры, которые были сломаны, теперь снова работают;
 *   stillBroken — лежат давно, в helpdesk о них больше не пишем.
 *
 * Файл: state/helpdesk-state.json (gitignored).
 */

import fs from 'fs';
import path from 'path';

const STATE_DIR  = path.resolve('state');
const STATE_FILE = path.join(STATE_DIR, 'helpdesk-state.json');

/**
 * Уникальный ключ камеры: "<systemId>|<имя_или_метка_камеры>".
 * helpdesk-обработка раньше использовала только системы и имена камер,
 * у нас уже есть и то и другое в объекте broken-camera.
 */
export const cameraKey = (item) => `${item.systemId || item.system}|${item.camera}`;

/**
 * Читает helpdesk-state. Если файла нет или он повреждён — возвращает
 * пустой state.
 */
export function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { lastRun: null, cameras: {} };
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      lastRun: parsed.lastRun || null,
      cameras: parsed.cameras || {},
    };
  } catch {
    return { lastRun: null, cameras: {} };
  }
}

/**
 * Атомарно сохраняет state (write tmp + rename).
 */
export function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

/**
 * Полностью обнуляет state. Используется флагом --reset-state.
 */
export function resetState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

/**
 * Сравнивает текущее множество сломанных камер с предыдущим state и
 * возвращает три категории. Мутирует state (lastRun + cameras).
 *
 * @param {object} state          — результат loadState()
 * @param {Array}  currentBroken  — массив объектов от collectBrokenCameras()
 *                                  (требует поле systemId, см. reporter.js)
 * @returns {{newlyBroken:Array, recovered:Array, stillBroken:Array}}
 */
export function diffAndUpdate(state, currentBroken) {
  const now = new Date().toISOString();
  const currentKeys = new Set(currentBroken.map(cameraKey));

  const newlyBroken = [];
  const stillBroken = [];
  const recovered   = [];

  // 1. Идём по текущим сломанным
  for (const item of currentBroken) {
    const key  = cameraKey(item);
    const prev = state.cameras[key];

    if (!prev) {
      // Камера сломалась впервые — отправить в helpdesk
      newlyBroken.push({ ...item, _firstBrokenAt: now });
      state.cameras[key] = {
        systemId: item.systemId,
        system:   item.system,
        group:    item.group,
        camera:   item.camera,
        status:   'broken',
        reason:   item.status,
        notes:    item.notes,
        since:    now,
        lastSeen: now,
      };
      continue;
    }

    if (prev.status !== 'broken') {
      // Раньше была восстановлена/неизвестна — снова сломалась
      newlyBroken.push({ ...item, _firstBrokenAt: now });
      state.cameras[key] = {
        ...prev,
        status:   'broken',
        reason:   item.status,
        notes:    item.notes,
        since:    now,
        lastSeen: now,
      };
      continue;
    }

    if (prev.reason !== item.status) {
      // Статус сменился (OFFLINE → "нет записи" или наоборот) — это новое
      // событие для helpdesk: причина проблемы изменилась
      newlyBroken.push({ ...item, _statusChanged: true, _previousStatus: prev.reason });
      state.cameras[key] = {
        ...prev,
        reason:   item.status,
        notes:    item.notes,
        lastSeen: now,
      };
      continue;
    }

    // Та же поломка, что и в прошлом прогоне — в helpdesk не идёт
    stillBroken.push({ ...item, _brokenSince: prev.since });
    state.cameras[key] = {
      ...prev,
      notes:    item.notes,
      lastSeen: now,
    };
  }

  // 2. Ищем восстановленные — те, что были broken, но не пришли в этот раз
  for (const [key, prev] of Object.entries(state.cameras)) {
    if (prev.status !== 'broken') continue;
    if (currentKeys.has(key)) continue;

    recovered.push({
      systemId: prev.systemId,
      system:   prev.system,
      group:    prev.group,
      camera:   prev.camera,
      previousStatus: prev.reason,
      previousNotes:  prev.notes,
      brokenSince:    prev.since,
      recoveredAt:    now,
    });
    // Помечаем как восстановленную (не удаляем — остаётся история)
    state.cameras[key] = {
      ...prev,
      status:      'active',
      recoveredAt: now,
      lastSeen:    now,
    };
  }

  state.lastRun = now;
  return { newlyBroken, recovered, stillBroken };
}
