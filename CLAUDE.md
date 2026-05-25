# AutoCamera Monitor — инструкции для агента
**Версия:** v2.0 | **Проект:** `C:\Users\dsadmin\Desktop\autocamera`

Автоматизированный мониторинг камер: проверяет 9 систем (Европласт + Онлайн),
формирует HTML-отчёт со скриншотами камер, рассылает письма заказчику и
helpdesk. Запуск по расписанию через Планировщик задач Windows — **человек
не наблюдает**. Работа без интерактивных подтверждений и без ожидания ввода.

Все комментарии и логи — **только на русском**.

---

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
│   ├── trassir            → TRASSIR SDK HTTP API (10.0.120.195:8080)
│   ├── ipanda-office      → RTSP DESCRIBE через NVR (10.0.120.192)
│   ├── hiwatch-sklad      → Hikvision ISAPI (10.0.120.30)
│   ├── ipanda-noviy-ceh   → RTSP DESCRIBE через NVR (10.0.120.220)
│   ├── evroplast-stroyka  → SMB-папки записей: \\10.0.120.4\Video\{9,11,13}
│   └── hiwatch-vyduv      → Hikvision ISAPI
│
└── Онлайн (группа "Онлайн")
    ├── beward             → SMB-шара \\192.168.99.122 freshness + ping
    ├── ivms               → Hikvision ISAPI per-camera (3 точки)
    └── rostelecom         → портал lk-b2b.camera.rt.ru (Playwright headless)
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

## Helpdesk-логика

- Письмо уходит **только при изменениях** (новые broken или восстановленные).
  Если те же N камер сломаны второй прогон подряд — письмо НЕ повторяется.
- Сравнение через `state/helpdesk-state.json` (ключ: `<sysId>|<camera name>`).
- Группа определяется полем `group` каждой системы (`"Европласт"` / `"Онлайн"`),
  отдельное письмо на каждую группу.
- Камеры из `helpdeskIgnore` / `unusedChannels` / TRASSIR-`knownOffline` не
  попадают в helpdesk.
- Сброс helpdesk-state — `node src/index.js --reset-state` или из меню.

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
| **SMTP** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | Отправка писем (Yandex PDD `dc1c.ru`) |
| **Получатели** | `REPORT_TO_EVROPLAST`, `REPORT_TO_ONLINE`, `REPORT_TO`, `HELPDESK_TO` | Адресаты отчётов и helpdesk |
| **TRASSIR** | `TRASSIR_USER`, `TRASSIR_PASS` | SDK login |
| **HiWatch** | `HIWATCH_SKLAD_URL/USER/PASS`, `HIWATCH_VYDUV_URL/USER/PASS` | NVR login |
| **iPanda** | `IPANDA_OFFICE_*`, `IPANDA_CEH_*` | NVR кредосы (RTSP) |
| **iVMS** | `IVMS_AERO_*`, `IVMS_T2_*`, `IVMS_MEGAFON_*` | Per-camera Hikvision |
| **BEWARD** | `BEWARD_SMB_USER`, `BEWARD_SMB_PASS` | SMB |
| **Стройка** | `STROYKA_SMB_USER`, `STROYKA_SMB_PASS` | SMB |
| **Ростелеком** | `RT_PORTAL_URL`, `RT_PORTAL_USER`, `RT_PORTAL_PASS` | Портал |
| **Bitrix (v2)** | `BITRIX_WEBHOOK_URL`, `BITRIX_ROOT_FOLDER_ID`, `BITRIX_STORAGE_ID` | Загрузка снимков |
| **Системные (v2)** | `FFMPEG_PATH`, `SNAPSHOT_RETENTION_DAYS` | ffmpeg для RTSP-снимков, retention папок в Bitrix |
| **Тестирование** | `TEST_MODE=true` | Принудительно перенаправляет письма (TEST-режим, на проде НЕ задавать) |

---

## Стройка — контроль качества SMB-записей

Чекер `recordings-check.js` (`type: smb-recordings`) ловит как «запись не пишется»,
так и «запись битая» — обрыв RTSP оставляет на шаре mp4-файл 48 байт.

Текущий путь: `\\10.0.120.4\Video\{9,11,13}` (3 канала, обновлено в мае 2026).

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

## Версионность

- **v2.0** (май 2026) — описано выше. Финальный архив v2-dev истории: ветка
  `v2-dev` в `git@github.com:alegis1337/autocamera.git`.
- **v1.0.1** (апрель 2026) — фикс детектирования битых mp4 на Стройке.
- **v1.0** (март 2026) — первый прод-релиз: 9 систем, отчёты по группам,
  helpdesk, планировщик, серый маркер камер.

История версий хранится в ветках git: `main` (актуальное), `v2-dev` (архив),
`feature-diagnose` (отложенная активная автодиагностика).
