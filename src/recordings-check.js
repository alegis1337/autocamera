/**
 * Проверка папок с записями по SMB.
 *
 * Используется для систем, где регистратор пишет mp4-файлы в SMB-шару:
 * каждый канал — отдельная папка, файлы ротируются (новый чанк раз в N минут).
 *
 * Алгоритм:
 *   1. Поднять SMB-сессию (idempotent).
 *   2. Для каждого канала найти самый свежий файл (LastWriteTime).
 *   3. online = recording = true, если возраст файла <= freshnessMin.
 *
 * Пример конфига в systems.json:
 *   {
 *     "id": "evroplast-stroyka",
 *     "type": "smb-recordings",
 *     "host": "10.0.120.4",
 *     "shareName": "video",
 *     "basePath": "video",
 *     "freshnessMin": 60,
 *     "channels": [
 *       { "index": 0, "name": "Канал 5",  "folder": "5"  },
 *       { "index": 1, "name": "Канал 9",  "folder": "9"  },
 *       { "index": 2, "name": "Канал 11", "folder": "11" }
 *     ]
 *   }
 */

import * as log from './logger.js';
import { runPowershell, ensureSmbSession } from './smb-utils.js';

const DEFAULT_FRESHNESS_MIN = 60;

async function listFreshness({ host, shareName, basePath, channels }) {
  const shareCodes = Array.from(shareName).map((c) => c.codePointAt(0)).join(',');
  const baseCodes  = basePath
    ? Array.from(basePath).map((c) => c.codePointAt(0)).join(',')
    : '';
  const foldersJson = JSON.stringify(channels.map((c) => c.folder)).replace(/'/g, "''");

  const script = `
    $ErrorActionPreference = 'SilentlyContinue'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8

    $shareName = [string]::new([char[]](${shareCodes}))
    $basePath  = ${baseCodes ? `[string]::new([char[]](${baseCodes}))` : "''"}
    $root = "\\\\${host}\\$shareName"
    if ($basePath) { $root = Join-Path $root $basePath }

    $folders = '${foldersJson}' | ConvertFrom-Json
    $now = Get-Date
    $results = @()

    foreach ($folder in $folders) {
      $dir = Join-Path $root $folder
      $newest = Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1

      if (-not $newest) {
        $results += [pscustomobject]@{
          folder = $folder; found = $false; ageMin = -1; file = ''; sizeMb = 0
        }
        continue
      }

      $ageMin = [math]::Round(($now - $newest.LastWriteTime).TotalMinutes, 1)
      $sizeMb = [math]::Round($newest.Length / 1MB, 1)
      $results += [pscustomobject]@{
        folder = $folder; found = $true; ageMin = $ageMin
        file = $newest.Name; sizeMb = $sizeMb
      }
    }

    $results | ConvertTo-Json -Compress -Depth 3
  `;

  const { stdout, stderr } = await runPowershell(script);
  const trimmed = stdout.trim();

  try {
    const parsed = JSON.parse(trimmed);
    return { items: Array.isArray(parsed) ? parsed : [parsed] };
  } catch (err) {
    return { error: `parse failed: ${err.message}; stdout=${trimmed.slice(0, 200)}; stderr=${stderr.slice(0, 200)}` };
  }
}

/**
 * @param {object} sys
 * @param {string} sys.id
 * @param {string} sys.host           "10.0.120.4"
 * @param {string} sys.shareName      имя шары, e.g. "video"
 * @param {string} [sys.basePath]     подпапка внутри шары, e.g. "video"
 * @param {string} sys.smbUser
 * @param {string} sys.smbPass
 * @param {number} [sys.freshnessMin] порог свежести в минутах
 * @param {Array}  sys.channels       [{ index, name, folder }]
 */
export async function checkRecordingsSystem(sys) {
  const {
    id, host, shareName, basePath = '',
    smbUser, smbPass,
    freshnessMin = DEFAULT_FRESHNESS_MIN,
    channels = [],
  } = sys;

  if (!host || !shareName) {
    const diag = `Не задан host или shareName в конфигурации системы "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!smbUser || !smbPass) {
    const diag = `Нет SMB-учётки для "${id}". Проверьте переменные окружения в .env (smbUserEnv / smbPassEnv).`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }
  if (!channels.length) {
    const diag = `Список каналов (channels) пуст для "${id}". Проверьте config/systems.json.`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  log.info(id, 'SMB-проверка папок записей', {
    host, share: `\\\\${host}\\${shareName}\\${basePath}`, channels: channels.length, user: smbUser,
  });

  const { ok, diag: smbDiag } = await ensureSmbSession(host, smbUser, smbPass);
  if (!ok) {
    return { cameras: [], error: smbDiag || 'SMB-сессия не установлена' };
  }

  const { items, error } = await listFreshness({ host, shareName, basePath, channels });
  if (error) {
    const diag = `Не удалось прочитать содержимое папок на \\\\${host}\\${shareName}\\${basePath}. ${error}`;
    log.error(id, diag);
    return { cameras: [], error: diag };
  }

  const byFolder = new Map(items.map((r) => [r.folder, r]));

  const result = channels.map((ch) => {
    const r = byFolder.get(ch.folder);

    if (!r || !r.found) {
      return {
        index: ch.index,
        name: ch.name,
        online: false,
        recording: false,
        audio: 'unknown',
        notes: 'нет файлов в папке',
      };
    }

    const age = Number(r.ageMin);
    const fresh = Number.isFinite(age) && age >= 0 && age <= freshnessMin;
    const ageLabel = age < 60
      ? `${age.toFixed(0)} мин`
      : `${(age / 60).toFixed(1)} ч`;

    return {
      index: ch.index,
      name: ch.name,
      online: fresh,
      recording: fresh,
      audio: 'unknown',
      notes: fresh
        ? `последний чанк ${ageLabel} назад (${r.sizeMb} МБ)`
        : `устарело: ${ageLabel} назад`,
    };
  });

  return { cameras: result, error: null };
}
