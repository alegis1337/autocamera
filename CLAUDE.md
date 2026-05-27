# AutoCamera Monitor — инструкции для агента
**Версия:** v2.2 | **Проект:** `C:\Users\dsadmin\Desktop\autocamera`

> **Обязательно к чтению в начале каждой новой сессии:** папка
> [`.claude rules/`](./.claude%20rules/) (в репо, без точки в начале — это
> имя с пробелом, не dot-folder). Начать с
> [`.claude rules/README.md`](./.claude%20rules/README.md) (индекс) и
> [`.claude rules/00-meta.md`](./.claude%20rules/00-meta.md) (как пользоваться
> правилами и как сам Claude их дополняет). Дальше — по темам: документация
> (`01-documentation.md`), git (`02-git.md`), секреты (`03-secrets.md`), стиль
> и язык (`04-style.md`).
>
> При конфликте между этим файлом и `.claude rules/` приоритет у `.claude
> rules/` — это более свежий и узкий источник. Сразу сказать пользователю
> и предложить синхронизировать `CLAUDE.md`.

Автоматизированный мониторинг камер: проверяет 9 систем (Европласт + Онлайн),
формирует HTML-отчёт со скриншотами камер, рассылает письма заказчику и
helpdesk. Запуск по расписанию через Планировщик задач Windows — **человек
не наблюдает**. Работа без интерактивных подтверждений и без ожидания ввода.

Язык общения — **только русский** (чат, комментарии, логи, коммиты). Полные
правила и исключения — в [`.claude rules/04-style.md`](./.claude%20rules/04-style.md).

---

## Что нового в v2.2 (27 мая 2026)

1. **Транслит русских имён систем и камер в `menu.ps1`** —
   функция `ConvertTo-Translit` (Unicode code points, encoding-agnostic).
   Раньше при заходе в пункт `G` имена «Производство (TRASSIR)»,
   «Офис (iPanda)» и т.п. выводились кашей `ЯтАЛУЛЦБеТеВЛЛ` из-за того,
   что `node` отдавал UTF-8, а PS 5.1 декодировал в cp866. Теперь —
   `Proizvodstvo (TRASSIR)`, `Ofis (iPanda)`, `Balakhta Megafon` и т.д.
   В шапке `menu.ps1` явно проставлены `[Console]::OutputEncoding = UTF8`
   и `$OutputEncoding = UTF8`, чтобы вывод `node` корректно попадал
   в PS-строки.
2. **Переработан `Setup-Schedule` под v2-формат `schedule.json`**
   (`light` + `daily` блоки). Прежний код читал плоские поля
   (`$config.taskName`, `$config.intervalHours`), получал `$null`
   и падал в `Get-ScheduledTask -TaskName $null`. Новое меню `S`:
   1=время Light, 2=интервал Light (мин), 3=duration Light (час),
   4=время Daily, 5=применить обе задачи, 6=удалить обе. Аналогично
   обновлён рендер строки «Zapusk:» в `Show-Menu` — теперь
   `Light 06:00 MSK kazhdye 15min, Daily 14:00 MSK [AKTIVNO]`.
3. **Активированы камеры 10 и 11 «Офис (iPanda)»** — `unusedChannels`
   у `ipanda-office` теперь `[]` (раньше `[10, 11]`). Все 16 каналов
   снова в проверке: `light` пишет статусы в timeline и `live.html`,
   `daily` снимает кадры и шлёт в helpdesk при поломке.
4. **Обязательная папка правил `.claude rules/`** (только локально). Каждый
   файл = одно правило (`00-meta`, `01-documentation`, `02-git`, `03-secrets`,
   `04-style`). Прочтение этой папки и `README.md` индекса — обязательный
   шаг в начале каждой новой сессии. См. блок в самом верху этого файла.
   Запрет `Co-Authored-By: Claude` снят (см. `02-git.md`).
   > Изначально папка была добавлена в репо, но 2026-05-27 переведена в
   > `.gitignore` — правила должны жить локально, а не на GitHub.
5. **Чистка кредов в `config/systems.json`**. `rtspUser`/`rtspPass`
   /`nvrRtspUser`/`nvrRtspPass` у `ipanda-office` и `ipanda-noviy-ceh`
   заменены на `*Env`-ссылки. Реальные значения переехали в `.env` под
   именами `IPANDA_OFFICE_RTSP_USER/PASS`, `IPANDA_NOVIY_CEH_RTSP_USER/PASS`,
   `IPANDA_NOVIY_CEH_NVR_RTSP_USER/PASS`. `src/index.js` (ветка `ipanda-rtsp`)
   и `src/snapshots.js` (`snapRtsp`) теперь читают через
   `process.env[sys.rtspUserEnv]` с fallback'ом на буквальные значения для
   обратной совместимости.
   > История git до этого коммита содержит реальные пароли — рекомендуется
   > ротировать RTSP-логин на NVR iPanda Офиса и пароли NVR/камер Нового
   > цеха на стороне самих устройств.
6. **Полная чистка IP и контактов из репо**. В `config/systems.json` все
   `host`/`nvrIp`/`cameras[].ip` заменены на `${VAR}`-плейсхолдеры,
   реальные адреса переехали в `.env` (~24 новые переменные: TRASSIR_HOST,
   IPANDA_OFFICE_NVR_IP, BEWARD_CAM_*_IP, IVMS_*_HOST, RT_CAM_*_IP).
   Добавлен `src/config-loader.js` — рекурсивная подстановка `${VAR}` →
   `process.env.VAR` на этапе загрузки конфига. Поддерживается
   `${VAR:-default}` для опциональных полей. Подпись «специалист
   технической поддержки» в email-отчётах (`src/reporter.js`) — через
   `REPORT_SIGN_NAME/COMPANY/PHONE`, по умолчанию пусто.
7. **pre-commit hook** `.git/hooks/pre-commit` (локально, не в репо) —
   автоматически блокирует коммит при подозрении на секрет: пароли,
   RFC 1918 IP, корпоративные домены, webhook'и Bitrix24. См.
   `.claude rules/05-pre-commit-hook.md`.
8. **Жёсткое правило 03-secrets** переписано: явные запреты на пароли,
   IP внутренней сети, ФИО/телефоны/email заказчика в коде. Список
   обязательных grep-проверок перед каждым `git add`.

## Что нового в v2.1 (май 2026)

1. **Чекер TP-Link Tapo** (`src/tplink-tapo-check.js`, тип `tplink-tapo`) —
   проверка Wi-Fi камер через RTSP+ffmpeg. Один вызов делает online, recording
   и снимок одной операцией. RTSP-credentials берутся из «Camera Account»
   камеры (создаётся в мобильном приложении Tapo, см. README).
2. **`extraCameras` у систем** — позволяет прицепить камеры другого типа к
   существующей системе. Используется чтобы ТС40 (Tapo Wi-Fi) шла «17-й
   камерой» внутри `hiwatch-sklad`, а не отдельным объектом в отчёте.
3. **Helpdesk-письмо переверстано под 1С** — простой HTML без таблиц/CSS,
   группировка по объектам строкой: `Офис — не работают камеры: 11, 12, 15`.
   В одном письме перечислены все актуально сломанные камеры (newly + still),
   а не только новые. Письма про «восстановлены» больше не отправляются —
   триггер строго по новой поломке.
4. **Серые камеры не плодят offline-события** в `state/timeline-*.json`. Раньше
   HiWatch Склад CH1–CH5 (NO VIDEO + `unusedChannels`) попадали в «Историю за
   день» — теперь `diffAndAppend` пропускает их через `isUnusedChannel`.
5. **`--only` не сохраняет state** ни в боевом, ни в dry-run режиме. Раньше
   выборочный прогон помечал все непроверенные сломанные камеры как
   «восстановленные», что давало ложные helpdesk-письма при следующем
   полном прогоне.
6. **Ростелеком: `portalRetries` снижен с 20 до 7**. 20 попыток × ~45 сек =
   15 мин (всё окно light-прогона). 7 попыток ≈ 5 мин — хватает на любые
   кратковременные сбои passport.rt.ru.
7. **Snapshot-pipeline не лезет в SMB**. `captureAll` явно отсекает
   `smb-recordings` и `beward-smb` до постановки в очередь — 10 warning-ов
   «не поддерживает снимки» больше не плодятся.

## Что нового в v2 (по сравнению с v1)

1. **Два режима запуска**: `--light` каждые 15 минут (быстрая проверка статусов
   + обновление `reports/live.html`) и `--daily` раз в день (полный прогон со
   снимками камер, email-отчёты, helpdesk).
2. **Снимки камер в отчёте** — миниатюры под каждым тайлом. Источник —
   локальный кэш «последнего рабочего снимка» (`screenshots/last-good/`).
   Полные снимки заливаются в Bitrix24 Disk.
3. **Live-монитор** — `reports/live.html` обновляется light-прогонами, имеет
   `meta-refresh` 30 сек.
4. **Отчёт за период** — пункт `H` в меню, аггрегирует все
   `state/timeline-YYYY-MM-DD.json` за указанный диапазон.
5. **Helpdesk-дедупликация** — `state/helpdesk-state.json` отслеживает текущее
   состояние, письмо уходит только при смене статуса камеры (broken↔active).
6. **Мастер добавления нового устройства** — пункт `G → A` в меню. Скрипт
   `src/detect-device.js` пробует Hikvision ISAPI / TRASSIR SDK / BEWARD /
   RTSP по IP, угадывает тип и предлагает прописать в `systems.json`.

---

## Архитектура

```
AutoCamera Monitor (Node.js ≥ 18, ES modules)
│
├── Европласт (группа "Европласт")
│   ├── trassir            → TRASSIR SDK HTTP API (${TRASSIR_HOST}:8080)
│   ├── ipanda-office      → RTSP DESCRIBE через NVR (${IPANDA_OFFICE_NVR_IP})
│   ├── hiwatch-sklad      → Hikvision ISAPI (${HIWATCH_SKLAD_URL})
│   │                       + extra: ТС40 (TP-Link Tapo, RTSP ${TAPO_TS40_HOST})
│   ├── ipanda-noviy-ceh   → RTSP DESCRIBE через NVR (${IPANDA_NOVIY_CEH_NVR_IP})
│   ├── evroplast-stroyka  → SMB-папки записей: \\${STROYKA_SMB_HOST}\Video\{9,11,13}
│   └── hiwatch-vyduv      → Hikvision ISAPI
│
└── Онлайн (группа "Онлайн")
    ├── beward             → SMB-шара \\${BEWARD_SMB_HOST} freshness + ping
    ├── ivms               → Hikvision ISAPI per-camera (3 точки)
    └── rostelecom         → портал РТ через Playwright headless
```

Никакого облачного AI. Только детерминированные запросы к API / SMB / RTSP /
ISAPI. Ростелеком — единственный случай, где нужен headless-браузер.

---

## Окружение

| Элемент | Значение |
|---|---|
| ОС | Windows 10/11 (VM) |
| Runtime | Node.js ≥ 18, ES modules |
| Корень | `C:\Users\dsadmin\Desktop\autocamera` |
| Секреты | `.env` (см. ниже) |
| Системы | `config\systems.json` (9 систем, поле `group`) |
| Расписание | `config\schedule.json` (`light` + `daily` секции) |
| Локальный snapshot-кэш | `screenshots\last-good\<sysId>\<idx>-<name>.jpg` |
| Состояние helpdesk | `state\helpdesk-state.json` (gitignored) |
| Журнал событий | `state\timeline-YYYY-MM-DD.json` (без срока хранения) |
| ffmpeg | через `FFMPEG_PATH` в `.env` (нужен для RTSP-снимков iPanda) |
| Bitrix Диск | inbound webhook через `BITRIX_WEBHOOK_URL` |
| Запуск вручную | `menu.ps1` (PowerShell UI) |
| Запуск авто | Windows Task Scheduler: `AutoCamera Light` + `AutoCamera Daily` |

---

## Структура кода (`src/`)

| Файл | Назначение |
|---|---|
| `index.js` | Главный оркестратор: `--light` или `--daily`, диспатч чекеров, snapshots, отчёты, email, helpdesk |
| `reporter.js` | HTML-отчёт с миниатюрами (CID для email, file:// для live.html), `sendReport`, `sendHelpdeskReport`, `collectBrokenCameras` |
| `logger.js` | Логгер (файл + консоль; уровни info/warn/error/debug) |
| `isapi.js` | Hikvision/HiWatch ISAPI (digest auth) — статусы и `Streaming/channels/.../picture` для снимков |
| `hikvision-multi.js` | iVMS — пер-камерный ISAPI |
| `trassir-check.js` | TRASSIR SDK HTTP API (login, /channels, /screenshot) |
| `rtsp-check.js` | iPanda — RTSP DESCRIBE через NVR |
| `beward-check.js` | BEWARD — свежесть SMB-файлов |
| `recordings-check.js` | Стройка — свежесть + контроль качества (битые 48-байт чанки) |
| `smb-utils.js` | Общие SMB-примитивы (`ensureSmbSession`, `runPowershell`) |
| `rostelecom-check.js` | Портал РТ — Playwright login + перехват API dashboard |
| `snapshots.js` | **(v2)** Захват кадра по типу системы; Bitrix upload; Rostelecom — Playwright перехват thumbnails |
| `bitrix-disk.js` | **(v2)** REST-клиент Bitrix24 Диска: upload / mkdir / publish / cleanup retention |
| `last-good.js` | **(v2)** Кэш «последнего рабочего снимка» камеры (локально в `screenshots/last-good/`) |
| `timeline.js` | **(v2)** Журнал событий offline/online за день + `summarizePeriod` для отчёта за период |
| `state.js` | **(v2)** Helpdesk-state: `loadState` / `diffAndUpdate` / `saveState` |
| `period-report.js` | **(v2)** CLI: `node src/period-report.js <fromYmd> <toYmd>` → HTML за диапазон |
| `detect-device.js` | **(v2)** CLI: автоопределение типа устройства по IP, для мастера добавления |
| `manage-cameras.mjs` | **(v2)** CLI для menu.ps1: list/gray/ungray/delete/add-system/add-cam/append-env |
| `manage-gray.mjs` | Старый CLI grey-management, оставлен для совместимости |
| `tplink-tapo-check.js` | **(v2.1)** Проверка TP-Link Tapo через RTSP+ffmpeg. Возвращает online/recording/snapshotPath. KLAP-handshake для SD-карты — TODO. |

---

## Поток выполнения

### Light-режим (`node src/index.js --light`)
1. Чекеры всех систем (как обычно).
2. `state/timeline-<сегодня>.json` обновляется новыми событиями offline/online.
3. `reports/live.html` перезаписывается со свежими статусами и миниатюрами из
   `screenshots/last-good/` (если есть).
4. **БЕЗ** снимков с камер, **БЕЗ** email, **БЕЗ** helpdesk.

### Daily-режим (`node src/index.js --daily`)
1. Чекеры всех систем.
2. Timeline обновляется как в light.
3. **Снимки всех камер** (online + offline) через `captureAll` →
   `screenshots/<runId>/...`.
4. Загрузка снимков в Bitrix Disk (`/AutoCamera/<группа>/<объект>/<YYYY-MM-DD>/`)
   с retention-чисткой папок старше `SNAPSHOT_RETENTION_DAYS`.
5. Обновление `screenshots/last-good/` для тех камер, у которых `online=true`
   (битые placeholder'ы из NVR в кэш не попадают).
6. HTML-отчёты: 1 полный (`reports/report-...-full.html`), 1 live, 2 по группам
   (Европласт, Онлайн). Email-отчёты с CID-картинками вложением.
7. **Helpdesk-дедупликация**: текущее множество broken сравнивается со
   `state/helpdesk-state.json`. Письмо уходит только при наличии новых/восстановленных камер.

### Ручной режим (`node src/index.js` без флагов)
- Эквивалентно `--daily`, но без записи в `runMode='daily'` — для совместимости
  со старыми вызовами из меню.

---

## Семантика статусов в отчёте

| `online` | Бейдж | Миниатюра | Смысл |
|---|---|---|---|
| `true` | зелёный | свежая / last-good | Камера в сети |
| `false` | красный | last-good (если есть) или «нет снимка» | Не передаёт видео |
| `true` + `recording=false` | оранжевый + ⚠ | свежая | Картинка есть, записи нет |
| `unused` (по конфигу) | серый, верх — пустой серый блок | — | Канал не используется |
| `null` (нет данных) | серый | — | Чекер не смог дать достоверный ответ |

**Серые камеры** определяются:
- TRASSIR — `knownOffline: [<displayName>, ...]` в `systems.json`
- Остальные — `unusedChannels: [<1-based-ch-id>, ...]` в `systems.json`

Изменяется через меню → `G` (Управление камерами).

---

## Helpdesk-логика (обновлено в v2.1)

- **Триггер строго по новой поломке** (`diff.newlyBroken.length > 0`).
  Recovered больше НЕ запускает отправку — оператору не нужны письма
  «всё хорошо».
- При срабатывании триггера в письме перечисляются **все актуально сломанные
  камеры** группы (`newlyBroken ∪ stillBroken`), а не только добавочные.
  Так оператор сразу видит полную картину по объекту.
- Письма **отдельные на каждую группу** (`"Европласт"` / `"Онлайн"`); группа
  без новых поломок не получает письма, даже если в другой группе что-то
  сломалось.
- **Формат — простой текст** для 1С: абзацами вида `Офис — не работают камеры:
  11, 12, 15`. Никаких inline-CSS и таблиц — 1С их слипал в кучу. Имена
  камер сокращаются: `CH15`→`15`, `Camera 02`→`2`, `IPCamera 03`→`IP3`.
- Сравнение через `state/helpdesk-state.json` (ключ: `<sysId>|<camera name>`).
- Камеры из `helpdeskIgnore` / `unusedChannels` / TRASSIR-`knownOffline` не
  попадают в helpdesk. `isUnusedChannel` экспортируется из `reporter.js` и
  переиспользуется в `state.js` / `timeline.js` / `collectBrokenCameras`.
- Сброс helpdesk-state — `node src/index.js --reset-state` или из меню.

### `--only` (выборочный прогон) ⚠️

`--only <sysId>` (как в боевом, так и в `--dry-run` режиме) **НЕ сохраняет
state и НЕ шлёт helpdesk** — выборка частичная, иначе все непроверенные
сломанные камеры были бы помечены как «восстановленные» и при следующем
полном прогоне дали бы ложное письмо `newlyBroken`.

---

## Меню (menu.ps1) — все пункты

```
=== Проверки ===
 1   Проверить ВСЕ системы (full daily)
 T   Тестовая проверка ВСЕХ (dry-run)
 2-10 Отдельная система: Производство, Офис, Склад, Новый цех, Стройка,
      Цех выдува, BEWARD, iVMS, Ростелеком

=== Просмотр ===
 R   Открыть последний отчёт
 V   Открыть live-monitor (reports/live.html)
 H   Отчёт за период (1=сегодня, 2=3 дн, 3=7 дн, 4=30 дн, 5=вручную)
 L   Открыть папку логов

=== Настройка ===
 S   Настроить расписание (Light interval + Daily time)
 E   Email-адреса (Европласт / Онлайн / Helpdesk / fallback)
 G   Управление камерами:
       список систем → выбор → выбор камеры → меню (gray/active/delete)
       A — Добавить новое устройство (мастер с detect-device)

 0   Выход
```

---

## Переменные окружения

| Группа | Ключи | Назначение |
|---|---|---|
| **SMTP** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Отправка писем (Yandex PDD или любой SMTP) |
| **Получатели** | `REPORT_TO_EVROPLAST`, `REPORT_TO_ONLINE`, `REPORT_TO`, `HELPDESK_TO` | Адресаты отчётов и helpdesk |
| **TRASSIR** | `TRASSIR_USER`, `TRASSIR_PASS` | SDK login |
| **HiWatch** | `HIWATCH_SKLAD_URL/USER/PASS`, `HIWATCH_VYDUV_URL/USER/PASS` | NVR login |
| **iPanda** | `IPANDA_OFFICE_*`, `IPANDA_CEH_*` | NVR кредосы (RTSP) |
| **iVMS** | `IVMS_AERO_*`, `IVMS_T2_*`, `IVMS_MEGAFON_*` | Per-camera Hikvision |
| **BEWARD** | `BEWARD_SMB_USER`, `BEWARD_SMB_PASS` | SMB |
| **Стройка** | `STROYKA_SMB_USER`, `STROYKA_SMB_PASS` | SMB |
| **Ростелеком** | `RT_PORTAL_URL`, `RT_PORTAL_USER`, `RT_PORTAL_PASS` | Портал |
| **TP-Link Tapo (v2.1)** | `TAPO_RTSP_USER`, `TAPO_RTSP_PASS` | Camera Account для RTSP/snapshot. `TAPO_USER`/`TAPO_PASS` — cloud-аккаунт, на будущее для KLAP API |
| **Bitrix (v2)** | `BITRIX_WEBHOOK_URL`, `BITRIX_ROOT_FOLDER_ID`, `BITRIX_STORAGE_ID` | Загрузка снимков |
| **Системные (v2)** | `FFMPEG_PATH`, `SNAPSHOT_RETENTION_DAYS` | ffmpeg для RTSP-снимков, retention папок в Bitrix |
| **Тестирование** | `TEST_MODE=true` | Принудительно перенаправляет письма (TEST-режим, на проде НЕ задавать) |

---

## Стройка — контроль качества SMB-записей

Чекер `recordings-check.js` (`type: smb-recordings`) ловит как «запись не пишется»,
так и «запись битая» — обрыв RTSP оставляет на шаре mp4-файл 48 байт.

Текущий путь: `\\${STROYKA_SMB_HOST}\Video\{9,11,13}` (3 канала, обновлено в мае 2026).

Параметры (опционально в `qualityCheck` блоке системы):

| Поле | Дефолт | Что делает |
|---|---|---|
| `sampleSize` | 20 | Сколько последних файлов брать |
| `minFileSizeKb` | 100 | Меньше — битый |
| `maxBadRatio` | 0.30 | > этой доли битых из выборки → канал плохой |
| `freshnessMin` | 60 | Свежесть последнего файла (минут) |

---

## Правила поведения агента

- **Не** запрашивать интерактивный ввод.
- **Не** зависать: у каждого сетевого вызова — таймаут.
- Ошибка одной камеры/системы — залогировать и продолжить.
- Критический сбой SMTP — сохранить отчёт локально, `exit 1`.
- Комментарии и логи — на русском.
- Никогда не ломать обратную совместимость полей результата (`cameras[i].online`,
  `recording`, `audio`, `notes`, `index`) — их читает `reporter.js`.
- `snapMap`-значения для миниатюр поддерживают два режима: `cid:` для email и
  относительный путь для file://. `index.js → buildSnapMap` собирает оба.

---

## extraCameras (v2.1)

`extraCameras` — массив на уровне системы, позволяющий «прицепить» камеры
другого типа к существующей системе. Используется, чтобы Wi-Fi Tapo
(физически отдельный аппарат) показывалась в отчёте как продолжение
NVR-сетки, а не как отдельный объект.

Пример (`hiwatch-sklad`):
```json
"extraCameras": [{
  "type": "tplink-tapo",
  "name": "ТС40",
  "host": "${TAPO_TS40_HOST}",
  "rtspPath": "/stream1",
  "rtspUserEnv": "TAPO_RTSP_USER",
  "rtspPassEnv": "TAPO_RTSP_PASS"
}]
```

Обработка:
- В `index.js` после основного чекера системы (только для `hiwatch`/`hikvision`)
  идёт ветка `if (Array.isArray(sys.extraCameras) ...)`. Tapo-extra вызывает
  `checkTplinkTapoSystem` с `id: sys.id` (чтобы last-good лежал в
  `screenshots/last-good/<sysId>/`).
- В результат камера получает `_extraType: 'tplink-tapo'` — это маркер для
  `snapshots.js → captureSnapshot`, чтобы взять правильный grab'ер.
- Индексы и id назначаются продолжая основной диапазон (16-я камера NVR →
  ТС40 получает index=16, id=17).
- `aiSummary` системы становится `ISAPI+Tapo: N online из M (вкл. K extra)`.

Чтобы добавить ещё один тип extra-камер — нужна аналогичная ветка в `index.js`
и `case` в `snapshots.js → captureSnapshot`.

---

## TP-Link Tapo (v2.1)

Чекер `tplink-tapo-check.js`. Поток:
1. RTSP-probe + snapshot одной операцией через ffmpeg
   (`rtsp://<user>:<pass>@<host>:554/stream1`).
2. Кадр получен → `online=true, recording=true, snapshotPath=...`.
3. Кадр не получен → разбор stderr: 401, 404, timeout — отличаем «креды
   неверные» от «камера в сети не отвечает».
4. Fallback: TCP-probe 443 + `verifyTapoHttps` (Tapo всегда отвечает JSON
   с `error_code`) → online=true с пометкой что RTSP-поток не открылся.
5. Если 443 закрыт, но ping ok → `Tapo-демон не отвечает (зависла?)`.

**Camera Account** = отдельный логин/пароль для RTSP, создаётся в мобильном
приложении Tapo → Settings → Advanced → Camera Account. Без него порт 554
закрыт и API не работает.

**Полная проверка SD-карты** (свободное место, статус записи) — не
реализована. Современные Tapo требуют **KLAP-handshake** на :443
(RSA-обмен ключами + AES-128-CBC c session key). Это ~250 строк crypto-кода
под конкретную модель. Сейчас `recording=true` приближённо: «RTSP-поток жив
= камера снимает = пишет, если microSD исправна». Прямой контроль SD
помечен `TODO(recording-sd)` в `tplink-tapo-check.js`.

---

## Версионность

- **v2.1** (26 мая 2026) — TP-Link Tapo, extraCameras, helpdesk под 1С,
  фильтры серых в timeline, --only безопасный.
- **v2.0** (май 2026) — live monitor, snapshots, period report, helpdesk
  dedupe. Финальный архив v2-dev истории: ветка `v2-dev` в
  приватный git-remote проекта.
- **v1.0.1** (апрель 2026) — фикс детектирования битых mp4 на Стройке.
- **v1.0** (март 2026) — первый прод-релиз: 9 систем, отчёты по группам,
  helpdesk, планировщик, серый маркер камер.

История версий хранится в ветках git: `main` (актуальное), `v2-dev` (архив),
`feature-diagnose` (отложенная активная автодиагностика).
