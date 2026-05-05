/**
 * yandex-disk.js — REST-клиент Яндекс.Диска для загрузки скриншотов камер.
 *
 * Использует встроенный fetch (Node 18+). Без сторонних зависимостей.
 *
 * OAuth-токен берётся из process.env.YANDEX_DISK_TOKEN.
 * Получение: https://oauth.yandex.ru/ → создать приложение → права
 * cloud_api:disk.write + cloud_api:disk.read → выпустить токен.
 *
 * Все функции бросают Error при 4xx/5xx (кроме ensureFolder при 409 —
 * "уже существует" игнорируется).
 */

import fs from 'fs';
import path from 'path';

const API_BASE = 'https://cloud-api.yandex.net/v1/disk';

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function token() {
  const t = process.env.YANDEX_DISK_TOKEN;
  if (!t) throw new Error('YANDEX_DISK_TOKEN не задан в .env');
  return t;
}

function authHeaders() {
  return { 'Authorization': `OAuth ${token()}` };
}

/** Простой ретрай для сетевых ошибок (но не для логических 4xx). */
async function fetchWithRetry(url, opts = {}, attempts = 2) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, opts);
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

/** Кодирует путь для query: только value, не ключ. */
function qpath(p) {
  return encodeURIComponent(p);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Создаёт папку на Я.Диске. Если уже существует (409) — игнорируется.
 * Создаёт промежуточные папки рекурсивно (Я.Диск REST не делает это сам).
 *
 * @param {string} remotePath — например "/AutoCamera-test/2026-05-05/0900"
 */
export async function ensureFolder(remotePath) {
  const parts = remotePath.split('/').filter(Boolean);
  let cur = '';
  for (const p of parts) {
    cur += '/' + p;
    const url = `${API_BASE}/resources?path=${qpath(cur)}`;
    const res = await fetchWithRetry(url, {
      method: 'PUT',
      headers: authHeaders(),
    });
    if (res.status === 409) continue;       // уже есть
    if (res.status >= 400 && res.status !== 201) {
      const body = await res.text().catch(() => '');
      throw new Error(`ensureFolder ${cur}: ${res.status} ${body.slice(0, 200)}`);
    }
  }
}

/**
 * Загружает локальный файл на Я.Диск.
 * Y.Disk схема: GET /resources/upload?path=...&overwrite=true вернёт href,
 * затем PUT файл по этому href (без авторизации, ссылка одноразовая).
 *
 * @param {string} localPath
 * @param {string} remotePath — куда положить (полный путь с именем файла)
 */
export async function uploadFile(localPath, remotePath) {
  if (!fs.existsSync(localPath)) {
    throw new Error(`uploadFile: локальный файл не найден ${localPath}`);
  }
  // 1. Получаем href для загрузки
  const url = `${API_BASE}/resources/upload?path=${qpath(remotePath)}&overwrite=true`;
  const meta = await fetchWithRetry(url, { headers: authHeaders() });
  if (!meta.ok) {
    const body = await meta.text().catch(() => '');
    throw new Error(`uploadFile getHref: ${meta.status} ${body.slice(0, 200)}`);
  }
  const { href, method = 'PUT' } = await meta.json();
  if (!href) throw new Error('uploadFile: пустой href');

  // 2. PUT файл по полученной ссылке
  const stream = fs.readFileSync(localPath);
  const put = await fetchWithRetry(href, {
    method,
    body: stream,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  if (!put.ok && put.status !== 201 && put.status !== 202) {
    const body = await put.text().catch(() => '');
    throw new Error(`uploadFile PUT: ${put.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Делает файл публичным и возвращает его публичный URL (страница-просмотр
 * на disk.yandex.ru — открывается в браузере).
 */
export async function publish(remotePath) {
  // 1. Опубликовать
  const pubUrl = `${API_BASE}/resources/publish?path=${qpath(remotePath)}`;
  const pub = await fetchWithRetry(pubUrl, {
    method: 'PUT',
    headers: authHeaders(),
  });
  if (!pub.ok) {
    const body = await pub.text().catch(() => '');
    throw new Error(`publish: ${pub.status} ${body.slice(0, 200)}`);
  }

  // 2. Получить public_url
  const metaUrl = `${API_BASE}/resources?path=${qpath(remotePath)}&fields=public_url`;
  const meta = await fetchWithRetry(metaUrl, { headers: authHeaders() });
  if (!meta.ok) {
    const body = await meta.text().catch(() => '');
    throw new Error(`publish getMeta: ${meta.status} ${body.slice(0, 200)}`);
  }
  const data = await meta.json();
  if (!data.public_url) throw new Error('publish: пустой public_url');
  return data.public_url;
}

/**
 * Удаляет файл/папку без перемещения в корзину.
 */
export async function deleteResource(remotePath) {
  const url = `${API_BASE}/resources?path=${qpath(remotePath)}&permanently=true`;
  const res = await fetchWithRetry(url, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  // 204 No Content = удалено сразу; 202 Accepted = асинхронное удаление; 404 = уже нет
  if (res.status >= 400 && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`deleteResource ${remotePath}: ${res.status} ${body.slice(0, 200)}`);
  }
}

/**
 * Перечисляет содержимое папки (только верхний уровень).
 *
 * @returns {Promise<Array<{name, type, modified, path}>>}
 */
export async function listFolder(remotePath, limit = 200) {
  const url = `${API_BASE}/resources?path=${qpath(remotePath)}&limit=${limit}&fields=_embedded.items.name,_embedded.items.type,_embedded.items.modified,_embedded.items.path`;
  const res = await fetchWithRetry(url, { headers: authHeaders() });
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`listFolder ${remotePath}: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return data._embedded?.items || [];
}

/**
 * Удаляет подпапки в rootPath, у которых имя выглядит как YYYY-MM-DD и
 * дата старше N дней. Используется для retention.
 *
 * @returns {Promise<{deleted:number, kept:number}>}
 */
export async function cleanupOlderThan(rootPath, days) {
  if (!days || days <= 0) return { deleted: 0, kept: 0 };
  const items = await listFolder(rootPath);
  const cutoff = Date.now() - days * 86400_000;

  let deleted = 0, kept = 0;
  for (const it of items) {
    if (it.type !== 'dir') { kept++; continue; }
    const m = it.name.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) { kept++; continue; }
    const [_, y, mo, d] = m;
    const ts = Date.parse(`${y}-${mo}-${d}T00:00:00Z`);
    if (isNaN(ts) || ts >= cutoff) { kept++; continue; }
    try {
      await deleteResource(it.path);
      deleted++;
    } catch {
      kept++;
    }
  }
  return { deleted, kept };
}

// ─── Высокоуровневая обёртка для index.js ────────────────────────────────────

/**
 * Полный цикл "загрузить + опубликовать": создаёт папки, грузит файл,
 * делает публичным и возвращает public_url. При ошибке любой стадии
 * возвращает null и логирует через optional logger.
 *
 * @param {string} localPath
 * @param {string} remotePath
 * @param {object} [options]
 * @param {Function} [options.onError] — (err, stage) => void
 * @returns {Promise<string|null>} public_url or null
 */
export async function uploadAndPublish(localPath, remotePath, options = {}) {
  const onError = options.onError || (() => {});
  try {
    const folder = path.posix.dirname(remotePath.replace(/\\/g, '/'));
    await ensureFolder(folder);
  } catch (err) {
    onError(err, 'ensureFolder');
    return null;
  }
  try {
    await uploadFile(localPath, remotePath);
  } catch (err) {
    onError(err, 'uploadFile');
    return null;
  }
  try {
    return await publish(remotePath);
  } catch (err) {
    onError(err, 'publish');
    return null;
  }
}
