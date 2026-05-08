/**
 * snapshots.js — Снятие кадра с камеры по типу системы.
 *
 * Поддерживаемые системы:
 *   • hikvision-multi (iVMS)        → ISAPI /Streaming/channels/101/picture
 *   • hiwatch / hikvision (NVR)     → ISAPI /Streaming/channels/<N>01/picture
 *   • ipanda-rtsp                   → ffmpeg grab one frame
 *   • trassir-sdk                   → SDK API /screenshot?channel=<guid>&sid=<sid>
 *
 * Не поддерживаем (будем класть localPath: null):
 *   • beward-smb, smb-recordings    — SMB-шары записей, не камеры
 *   • rt-portal                     — портал РТ, без отдельного API
 *
 * Каждый локальный файл сохраняется как:
 *   screenshots/<runId>/<systemId>/<index>-<safeName>.jpg
 *
 * Удаление локальных файлов — забота вызывающего кода (после загрузки на Я.Диск).
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as log from './logger.js';
import { isapiGetBinary } from './isapi.js';

const execFileP = promisify(execFile);

const trassirAgent = new https.Agent({ rejectUnauthorized: false });

// ─── Утилиты ─────────────────────────────────────────────────────────────────

function safeName(s) {
  return String(s || 'cam').replace(/[\/\\:*?"<>|]/g, '_').slice(0, 60);
}

function snapshotsRoot() {
  return path.resolve('screenshots');
}

/**
 * Готовит локальный путь для скриншота. Создаёт нужные папки.
 */
export function localPathFor(runId, sysId, cam) {
  const dir = path.join(snapshotsRoot(), runId, sysId);
  fs.mkdirSync(dir, { recursive: true });
  const idx = (cam.index ?? 0).toString().padStart(2, '0');
  return path.join(dir, `${idx}-${safeName(cam.name)}.jpg`);
}

// ─── Захват кадра по типу системы ────────────────────────────────────────────

/**
 * Snapshot с одиночной Hikvision-камеры (hikvision-multi).
 * Используется отдельный host на каждую камеру.
 */
async function snapHikvisionMulti(sys, cam) {
  if (!cam.host) return { ok: false, error: 'нет cam.host' };
  const port  = cam.port || 80;
  const baseUrl = `http://${cam.host}:${port}`;
  const user = cam.user || (cam.userEnv ? process.env[cam.userEnv] : '') || '';
  const pass = cam.pass || (cam.passEnv ? process.env[cam.passEnv] : '') || '';
  if (!user || !pass) return { ok: false, error: 'нет логина/пароля' };

  // У одиночной камеры один канал — channel=101 (camera 1, mainstream)
  return await isapiSnapshot(baseUrl, 101, user, pass);
}

/**
 * Snapshot с камеры за NVR (hiwatch / hikvision NVR).
 * channel = <camera 1-based id>01.
 */
async function snapHikvisionNvr(sys, cam) {
  const baseUrl = String(sys.url || process.env[sys.urlEnv] || '').replace(/\/doc\/page\/login\.asp.*/, '').replace(/\/$/, '');
  if (!baseUrl) return { ok: false, error: 'нет baseUrl' };
  const user = sys.user || process.env[sys.userEnv] || '';
  const pass = process.env[sys.passEnv] || '';
  if (!user || !pass) return { ok: false, error: 'нет логина/пароля' };

  const camId = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
  const channel = `${camId}01`;
  return await isapiSnapshot(baseUrl, channel, user, pass);
}

/** Общий вызов /Streaming/channels/<channel>/picture. */
async function isapiSnapshot(baseUrl, channel, user, pass) {
  try {
    const buf = await isapiGetBinary(baseUrl, `/ISAPI/Streaming/channels/${channel}/picture`, user, pass);
    if (!buf || buf.length < 200) return { ok: false, error: 'пустой ответ' };
    return { ok: true, buffer: buf };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Snapshot через ffmpeg от RTSP-потока.
 * Один кадр (-frames:v 1), TCP-транспорт, тайм-аут 8 сек.
 */
async function snapRtsp(sys, cam, localPath) {
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

  // Строим RTSP URL
  let rtspUrl;
  if (cam.rtspPath) {
    // Через NVR (Hikvision-формат): rtsp://user:pass@nvrIp/Streaming/Channels/N01
    if (cam.viaNvr && sys.nvrIp) {
      const u = sys.nvrRtspUser || sys.rtspUser || 'admin';
      const p = sys.nvrRtspPass || sys.rtspPass || '';
      rtspUrl = `rtsp://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${sys.nvrIp}${cam.rtspPath}`;
    } else if (cam.ip) {
      const u = sys.rtspUser || 'admin';
      const p = sys.rtspPass || '';
      rtspUrl = `rtsp://${encodeURIComponent(u)}:${encodeURIComponent(p)}@${cam.ip}${cam.rtspPath}`;
    }
  }
  if (!rtspUrl) return { ok: false, error: 'не получилось собрать RTSP URL' };

  const args = [
    '-rtsp_transport', 'tcp',
    '-y',
    '-i', rtspUrl,
    '-frames:v', '1',
    '-q:v', '5',
    '-loglevel', 'error',
    localPath,
  ];

  try {
    await execFileP(ffmpeg, args, { timeout: 10_000, windowsHide: true });
    if (!fs.existsSync(localPath) || fs.statSync(localPath).size < 200) {
      return { ok: false, error: 'ffmpeg создал пустой/слишком маленький файл' };
    }
    return { ok: true, fromFile: true };
  } catch (err) {
    return { ok: false, error: `ffmpeg: ${err.message.slice(0, 120)}` };
  }
}

/**
 * Кэш sid TRASSIR per host:port. Хранит Promise<sid>, чтобы N параллельных
 * snapTrassir для одной системы делали ровно один login.
 */
const trassirSidCache = new Map();

function loginTrassir(host, port, user, pass) {
  const loginPath = `/login?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
  return trassirJson(host, port, loginPath).then((json) => {
    if (!json.sid) throw new Error('login: пустой sid');
    return json.sid;
  });
}

async function getTrassirSid(host, port, user, pass) {
  const key = `${host}:${port}`;
  if (!trassirSidCache.has(key)) {
    // Кладём промис в кэш ДО await — все одновременные вызовы получат его
    trassirSidCache.set(key, loginTrassir(host, port, user, pass).catch((err) => {
      // При ошибке убираем из кэша, чтобы следующий вызов мог попробовать ещё
      trassirSidCache.delete(key);
      throw err;
    }));
  }
  return trassirSidCache.get(key);
}

/**
 * Snapshot через TRASSIR SDK.
 * Login кэшируется per host:port — все 22 камеры одного TRASSIR'а используют
 * один sid (полученный одним запросом).
 */
async function snapTrassir(sys, cam) {
  const host = sys.host;
  const port = sys.port || 8080;
  const user = process.env[sys.userEnv] || sys.user || '';
  const pass = process.env[sys.passEnv] || sys.pass || '';
  if (!host || !user || !pass) return { ok: false, error: 'нет host/login' };

  // Найти guid камеры в sys.cameraGuids: значение = name → ключ = guid
  const guids = sys.cameraGuids || {};
  const guid = Object.entries(guids).find(([_, v]) => v === cam.name)?.[0];
  if (!guid) return { ok: false, error: `guid не найден в cameraGuids для "${cam.name}"` };

  // Login (через кэш — один раз на host:port)
  let sid;
  try {
    sid = await getTrassirSid(host, port, user, pass);
  } catch (err) {
    return { ok: false, error: `login: ${err.message}` };
  }

  // Screenshot
  try {
    const buf = await trassirBinary(host, port, `/screenshot?channel=${guid}&sid=${sid}`);
    if (!buf || buf.length < 200) return { ok: false, error: 'пустой screenshot' };
    return { ok: true, buffer: buf };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function trassirJson(host, port, pathQuery, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathQuery, agent: trassirAgent, headers: { Accept: 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try {
          const m = buf.match(/^\s*(\{[\s\S]*?\})\s*(?:\/\*|$)/);
          resolve(JSON.parse(m ? m[1] : buf));
        } catch (e) { reject(new Error(`bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

function trassirBinary(host, port, pathQuery, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host, port, path: pathQuery, agent: trassirAgent }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
  });
}

// ─── Главный API ─────────────────────────────────────────────────────────────

/**
 * Захватывает кадр одной камеры. Сохраняет JPEG в локальный путь.
 *
 * @param {string} runId — общий идентификатор прогона (для папки)
 * @param {object} sys   — система целиком (со всеми config-полями)
 * @param {object} cam   — камера из sys.cameras (с host/port/index)
 * @returns {Promise<{ok:boolean, localPath?:string, error?:string}>}
 */
export async function captureSnapshot(runId, sys, cam) {
  const localPath = localPathFor(runId, sys.id, cam);

  let result;
  switch (sys.type) {
    case 'hikvision-multi':
      result = await snapHikvisionMulti(sys, cam);
      break;
    case 'hiwatch':
    case 'hikvision':
      result = await snapHikvisionNvr(sys, cam);
      break;
    case 'ipanda-rtsp':
      result = await snapRtsp(sys, cam, localPath);
      break;
    case 'trassir-sdk':
      result = await snapTrassir(sys, cam);
      break;
    default:
      return { ok: false, error: `тип системы ${sys.type} не поддерживает снимки` };
  }

  // Если получили буфер — пишем на диск
  if (result.ok && result.buffer && !result.fromFile) {
    fs.writeFileSync(localPath, result.buffer);
  }

  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, localPath };
}

/**
 * Параллельно снимает кадры для всех ONLINE камер. Не диагностирует, не
 * лезет в Я.Диск — только пишет JPEG в screenshots/<runId>/.
 *
 * @param {Array}  systemResults
 * @param {string} runId
 * @param {object} options
 * @param {number} options.concurrency — default 5
 * @returns {Promise<Array<{sysId, camIndex, camName, localPath, error}>>}
 */
export async function captureAll(systemResults, runId, options = {}) {
  const concurrency = options.concurrency || 5;
  const targets = [];
  for (const sys of systemResults) {
    if (sys.error) continue;
    for (const cam of sys.cameras) {
      if (cam.online !== true) continue;       // оффлайн — снимать нечего
      const unused = sys.unusedChannels || [];
      const ch = cam.id != null ? cam.id : (cam.index ?? 0) + 1;
      if (unused.includes(ch)) continue;
      targets.push({ sys, cam });
    }
  }

  log.info('snapshot', `Готовлю снимки`, { count: targets.length, concurrency });

  const out = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (cursor < targets.length) {
      const idx = cursor++;
      const { sys, cam } = targets[idx];
      try {
        const r = await captureSnapshot(runId, sys, cam);
        if (!r.ok) {
          log.warn('snapshot', `${sys.id}/${cam.name}: ${r.error}`);
        }
        out[idx] = {
          sysId: sys.id,
          camIndex: cam.index,
          camName: cam.name,
          localPath: r.ok ? r.localPath : null,
          error:     r.ok ? null         : r.error,
        };
      } catch (err) {
        log.warn('snapshot', `${sys.id}/${cam.name}: ${err.message}`);
        out[idx] = { sysId: sys.id, camIndex: cam.index, camName: cam.name, localPath: null, error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Удаляет всю папку screenshots/<runId>/ после успешной заливки на Я.Диск.
 */
export function cleanupRun(runId) {
  const dir = path.join(snapshotsRoot(), runId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
