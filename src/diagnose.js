/**
 * diagnose.js — Активная диагностика причин падения камер.
 *
 * Когда камера упала (online === false) или не пишет (recording === false),
 * выполняем серию проб (ping, TCP-connect) к самой камере и/или к её
 * регистратору, чтобы определить вероятную причину.
 *
 * Каждой "сломанной" камере добавляется поле:
 *   cam.diagnosis = {
 *     rootCause:      'Регистратор недоступен',
 *     recommendation: 'Проверить питание и сеть регистратора 10.0.120.30',
 *     probes:         { systemPing: {ok}, systemHttp: {ok}, ... },
 *   }
 *
 * Используется только для отображения в отчёте и helpdesk-письме.
 * Решений сама не принимает.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';

const execFileP = promisify(execFile);

// ─── Базовые пробы ───────────────────────────────────────────────────────────

/**
 * ICMP ping одной попыткой через системный ping.exe (Windows).
 * @returns {{ok:boolean, time?:number, error?:string}}
 */
export async function pingHost(host, timeoutMs = 1500) {
  if (!host) return { ok: false, error: 'no host' };
  try {
    // -n 1: один пакет, -w: timeout в мс
    const { stdout } = await execFileP('ping', ['-n', '1', '-w', String(timeoutMs), host], {
      timeout: timeoutMs + 1500,
      windowsHide: true,
    });
    // ttl=N в ответе — значит хост ответил
    if (/ttl[=]/i.test(stdout)) {
      const m = stdout.match(/(?:время|time)[<=](\d+)\s*мс|(?:время|time)[<=](\d+)\s*ms/i);
      return { ok: true, time: m ? Number(m[1] || m[2]) : null };
    }
    return { ok: false, error: 'no reply' };
  } catch (e) {
    return { ok: false, error: e.code || e.message };
  }
}

/**
 * TCP-handshake до host:port. Без отправки данных.
 * @returns {{ok:boolean, error?:string}}
 */
export async function tcpConnect(host, port, timeoutMs = 3000) {
  if (!host || !port) return { ok: false, error: 'no host/port' };
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(res);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect',  () => finish({ ok: true }));
    socket.once('timeout',  () => finish({ ok: false, error: 'timeout' }));
    socket.once('error',    (err) => finish({ ok: false, error: err.code || err.message }));
    try {
      socket.connect(port, host);
    } catch (err) {
      finish({ ok: false, error: err.code || err.message });
    }
  });
}

// ─── Хелперы ─────────────────────────────────────────────────────────────────

function hostFromUrl(url) {
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
}

/**
 * Простой concurrency-limiter: запускает не более `limit` промисов одновременно.
 * Возвращает массив результатов в порядке items.
 */
async function withLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = await fn(items[idx], idx);
      } catch (err) {
        results[idx] = { __error: err.message };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Камера считается сломанной для целей диагностики, если она offline или
 * картинка есть, но не пишется.
 */
function isBroken(cam) {
  if (cam.online === false) return true;
  if (cam.online === true && cam.recording === false) return true;
  return false;
}

// ─── Запуск проб для одной камеры ────────────────────────────────────────────

/**
 * По sys.type выбираем какие пробы делать. Возвращает объект probes —
 * имена ключей семантичны для дальнейшего classify().
 */
async function runProbes(sys, cam) {
  const probes = {};

  // Хост системы — может быть в разных полях в зависимости от типа
  const systemHost =
       sys.host
    || hostFromUrl(sys.url)
    || hostFromUrl(process.env[sys.urlEnv])
    || hostFromUrl(process.env[sys.portalUrlEnv])
    || null;

  switch (sys.type) {
    case 'hiwatch':
    case 'hikvision': {
      // Один NVR на все камеры. Если он мёртв — упадут все.
      if (systemHost) {
        probes.systemPing = await pingHost(systemHost);
        if (probes.systemPing.ok) {
          probes.systemHttp = await tcpConnect(systemHost, 80, 2000);
        }
      }
      break;
    }
    case 'ipanda-rtsp': {
      // Камеры могут идти через NVR или напрямую
      if (cam.viaNvr && sys.nvrIp) {
        probes.nvrPing = await pingHost(sys.nvrIp);
        if (probes.nvrPing.ok) {
          probes.nvrRtsp = await tcpConnect(sys.nvrIp, 554, 2000);
        }
      } else if (cam.ip) {
        probes.cameraPing = await pingHost(cam.ip);
        if (probes.cameraPing.ok) {
          probes.cameraRtsp = await tcpConnect(cam.ip, 554, 2000);
        }
      }
      break;
    }
    case 'hikvision-multi': {
      // У каждой камеры свой host — проверяем индивидуально
      const camHost = cam.host || cam.ip;
      if (camHost) {
        probes.cameraPing = await pingHost(camHost);
        if (probes.cameraPing.ok) {
          probes.cameraHttp = await tcpConnect(camHost, cam.port || 80, 2000);
        }
      }
      break;
    }
    case 'beward-smb':
    case 'smb-recordings': {
      // SMB-шара: проверяем хост и порт 445 (SMB)
      if (systemHost) {
        probes.systemPing = await pingHost(systemHost);
        if (probes.systemPing.ok) {
          probes.systemSmb = await tcpConnect(systemHost, 445, 2000);
        }
      }
      break;
    }
    case 'trassir-sdk': {
      if (sys.host) {
        probes.systemPing = await pingHost(sys.host);
        if (probes.systemPing.ok) {
          probes.systemHttp = await tcpConnect(sys.host, sys.port || 8080, 2000);
        }
      }
      break;
    }
    case 'rt-portal': {
      // Сам портал — общий для всех камер
      if (cam.ip) probes.cameraPing = await pingHost(cam.ip);
      break;
    }
  }

  return probes;
}

// ─── Классификация ───────────────────────────────────────────────────────────

/**
 * По набору проб + cam.notes выбирает наиболее вероятную причину.
 * Возвращает { rootCause, recommendation } или { rootCause: null }.
 */
function classify(sys, cam, probes) {
  const notes = String(cam.notes || '').toLowerCase();

  // 1. Authentication — самая характерная по сообщениям
  if (/auth|401|403|unauthor|неверн.*(логин|пароль)|access denied|не авторизован/i.test(notes)) {
    return {
      rootCause:      'Сменился пароль или нет доступа',
      recommendation: `Сверить кредс системы "${sys.name}" в .env`,
    };
  }

  // 2. Регистратор не пингуется — это объясняет всё
  if (probes.systemPing && !probes.systemPing.ok) {
    const host = sys.host || hostFromUrl(sys.url) || hostFromUrl(process.env[sys.urlEnv]) || '?';
    return {
      rootCause:      `Регистратор/сервер ${host} не отвечает на ping`,
      recommendation: 'Проверить питание и сетевое подключение регистратора',
    };
  }

  // 3. Регистратор пингуется, но порт сервиса закрыт
  const sysServiceClosed =
       (probes.systemHttp && !probes.systemHttp.ok)
    || (probes.systemSmb  && !probes.systemSmb.ok);
  if (probes.systemPing?.ok && sysServiceClosed) {
    return {
      rootCause:      'Регистратор отвечает, но сервис не запущен',
      recommendation: 'Перезапустить сервис на регистраторе (или проверить firewall)',
    };
  }

  // 4. NVR (для iPanda через NVR) — то же что systemPing для других
  if (probes.nvrPing && !probes.nvrPing.ok) {
    return {
      rootCause:      `NVR ${sys.nvrIp} не пингуется`,
      recommendation: 'Проверить питание NVR и сеть',
    };
  }
  if (probes.nvrPing?.ok && probes.nvrRtsp && !probes.nvrRtsp.ok) {
    return {
      rootCause:      'NVR пингуется, RTSP-порт 554 закрыт',
      recommendation: 'Перезапустить службу RTSP на NVR',
    };
  }

  // 5. Камера индивидуально не пингуется (hikvision-multi или прямые RTSP)
  if (probes.cameraPing && !probes.cameraPing.ok) {
    const host = cam.host || cam.ip || '?';
    return {
      rootCause:      `Камера ${host} не отвечает на ping`,
      recommendation: 'Проверить питание камеры (PoE) и патч-корд',
    };
  }

  // 6. Камера пингуется, но её сервисный порт закрыт
  const camServiceClosed =
       (probes.cameraHttp && !probes.cameraHttp.ok)
    || (probes.cameraRtsp && !probes.cameraRtsp.ok);
  if (probes.cameraPing?.ok && camServiceClosed) {
    return {
      rootCause:      'Камера пингуется, но сервисный порт закрыт',
      recommendation: 'Перезагрузить камеру (отключить и включить PoE)',
    };
  }

  // 7. Online, но не пишется — это диагноз отдельный
  if (cam.online === true && cam.recording === false) {
    return {
      rootCause:      'Камера online, но запись не идёт',
      recommendation: 'Проверить место на диске NVR и расписание записи',
    };
  }

  // 8. Timeout/тайм-аут при доступном хосте — поток повис
  const hostUp = probes.systemPing?.ok || probes.cameraPing?.ok || probes.nvrPing?.ok;
  if (/timeout|тайм-аут|истекло/i.test(notes) && hostUp) {
    return {
      rootCause:      'Поток камеры подвис (хост доступен)',
      recommendation: 'Перезапустить трансляцию на регистраторе',
    };
  }

  return { rootCause: null, recommendation: null };
}

// ─── Главный API ─────────────────────────────────────────────────────────────

/**
 * Запускает диагностику для всех сломанных камер во всех систмах.
 * Мутирует объекты камер: добавляет cam.diagnosis.
 *
 * @param {Array}  systemResults
 * @param {object} options
 * @param {number} options.max          — макс. камер для диагностики (массовый сбой)
 * @param {number} options.concurrency  — параллелизм (по умолчанию 8)
 * @param {Function} options.logger     — функция логирования (необязательно)
 * @returns {Promise<{diagnosed:number, skipped:number}>}
 */
export async function diagnoseAll(systemResults, options = {}) {
  const max         = options.max         || 30;
  const concurrency = options.concurrency || 8;

  // Собираем плоский список { sys, cam } всех "сломанных"
  const targets = [];
  for (const sys of systemResults) {
    if (sys.error) continue; // ошибку всей системы диагностируем отдельно
    for (const cam of sys.cameras) {
      if (isBroken(cam)) targets.push({ sys, cam });
    }
  }

  // Cap для защиты от массового сбоя
  const toRun  = targets.slice(0, max);
  const skipped = targets.length - toRun.length;

  for (const { cam } of targets.slice(max)) {
    cam.diagnosis = {
      rootCause:      'Диагностика пропущена (массовый сбой)',
      recommendation: `Падение >${max} камер — диагностируйте вручную`,
      probes:         {},
    };
  }

  await withLimit(toRun, concurrency, async ({ sys, cam }) => {
    const probes = await runProbes(sys, cam);
    const { rootCause, recommendation } = classify(sys, cam, probes);
    cam.diagnosis = { rootCause, recommendation, probes };
  });

  // Системные ошибки тоже хочется задиагностировать (пинг к sys.host)
  for (const sys of systemResults) {
    if (!sys.error) continue;
    const systemHost =
         sys.host
      || hostFromUrl(sys.url)
      || hostFromUrl(process.env[sys.urlEnv])
      || hostFromUrl(process.env[sys.portalUrlEnv])
      || null;
    if (!systemHost) continue;

    const ping = await pingHost(systemHost);
    if (!ping.ok) {
      sys.diagnosis = {
        rootCause:      `Хост ${systemHost} недоступен (no ping)`,
        recommendation: 'Проверить питание/сеть регистратора',
        probes:         { systemPing: ping },
      };
    } else {
      sys.diagnosis = {
        rootCause:      'Хост пингуется, но проверка не прошла',
        recommendation: 'См. notes — обычно auth или сервис лёг',
        probes:         { systemPing: ping },
      };
    }
  }

  return { diagnosed: toRun.length, skipped };
}
