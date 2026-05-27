# AutoCamera Monitor

Автоматическая проверка камер видеонаблюдения по расписанию с отправкой отчётов
на email и заявок в helpdesk. Запускается на отдельной VM по расписанию Windows
Task Scheduler — человек не нужен.

**Версия 2.2** · Windows 10/11 · Node.js ≥ 18 · ES modules

---

## Что делает

- Проверяет онлайн/офлайн статус **9 систем видеонаблюдения** (~100 камер)
- Контролирует, идёт ли запись на регистраторе
- Проверяет свежесть и качество SMB-записей (Стройка, BEWARD)
- Снимает кадры с камер и кладёт миниатюры в HTML-отчёт
- Архивирует полноразмерные снимки в Bitrix24 Disk
- Рассылает email-отчёты по группам (Европласт, Онлайн)
- Создаёт заявки в helpdesk **только при появлении новых поломок** —
  без дублей и без шумных писем о восстановлении. В письме перечислены все
  актуально сломанные камеры группы, отсортированные по объекту
- Накапливает журнал событий за день — отчёт за период (день / неделя / месяц)

## Системы камер

| Объект | Тип проверки | Камер |
|---|---|---|
| Производство (TRASSIR) | TRASSIR SDK HTTP API | ~24 |
| Офис (iPanda) | RTSP DESCRIBE через NVR | 16 |
| **Склад (HiWatch)** | Hikvision ISAPI + Tapo RTSP | 16 + ТС40 |
| Новый цех (iPanda) | RTSP DESCRIBE через NVR | 10 |
| Стройка (записи) | SMB-папки `\\10.0.120.4\Video\{9,11,13}` | 3 канала |
| Цех выдува (HiWatch) | Hikvision ISAPI | 16 |
| BEWARD (удалённые) | SMB-шара (свежесть файлов) | 7 |
| iVMS (Hikvision) | ISAPI per-camera | 3 |
| Ростелеком | Портал РТ через Playwright | 7 |

## Что нового в v2.2 (27 мая 2026)

- **Меню на транслите** — `menu.ps1` теперь корректно показывает имена
  систем и камер в латинице (`Proizvodstvo (TRASSIR)`, `Ofis (iPanda)`,
  `Balakhta Megafon` и т.д.). Раньше при заходе в пункт `G` PowerShell
  декодировал UTF-8-вывод `node` как cp866 и выводил кашу.
- **Setup-Schedule под v2-формат** — пункт `S` переработан для нового
  `config/schedule.json` с блоками `light` и `daily`. Шесть вариантов
  настройки: время Light, интервал Light (мин), duration Light (час),
  время Daily, применить обе задачи, удалить обе. Раньше падал на
  `Get-ScheduledTask -TaskName $null`, потому что читал старые плоские
  поля.
- **Офис (iPanda)** — камеры 10 и 11 сняты с «серого» маркера. Все 16
  каналов снова в проверке.
- **Папка правил `.claude rules/`** — рабочие соглашения по проекту
  (документация, git, секреты, стиль). Версионируется вместе с кодом.
- **`Co-Authored-By: Claude`** — разрешено в коммитах (раньше было
  запрещено).

## Что нового в v2.1 (май 2026)

- **TP-Link Tapo** — поддержка Wi-Fi камер через RTSP + Camera Account.
  Один вызов ffmpeg делает online + recording + snapshot одной операцией.
- **`extraCameras`** — поле системы, позволяющее «прицепить» камеру другого
  типа к существующей системе. ТС40 (Tapo Wi-Fi) теперь идёт 17-й камерой
  в сетке Склада, а не отдельным объектом в отчёте.
- **Helpdesk под 1С** — простой текст вместо HTML-таблиц (1С слипал таблицы
  в кучу). Формат: `Офис — не работают камеры: 11, 12, 15`.
- **Без писем о восстановлении** — триггер helpdesk строго по новой поломке.
  Восстановление видно только в дневном email-отчёте.
- **Серые камеры** (unused channels, TRASSIR knownOffline) больше не попадают
  в «Историю за день» — раньше HiWatch Склад CH1–CH5 c «NO VIDEO» создавали
  пустые offline-события.
- **Безопасный `--only`** — выборочный прогон не сохраняет state и не шлёт
  helpdesk. Раньше пометил бы все непроверенные сломанные как «восстановленные».
- **Ростелеком** — `portalRetries` снижен с 20 до 7 (раньше 20 × 45 сек = 15 мин,
  пожирало всё окно light-прогона при недоступности портала).

[Полная история изменений](https://github.com/alegis1337/autocamera/commits/main)

## Стек

Node.js 18+ (ES modules) · Playwright (headless Chromium) · nodemailer · ffmpeg
· PowerShell (меню + планировщик задач Windows) · Bitrix24 Disk REST API.

Никакого облачного AI — все проверки детерминированные (HTTP API / SMB / RTSP /
ISAPI). Headless-браузер используется только для портала Ростелеком.

## Режимы запуска

| Команда | Когда вызывается | Что делает |
|---|---|---|
| `node src/index.js --light` | каждые 15 мин, 06:00–20:00 МСК | статусы + timeline + `reports/live.html` |
| `node src/index.js --daily` | раз в день в 14:00 МСК | + снимки + email-отчёты + helpdesk |
| `node src/index.js` | ручной запуск | как `--daily` |

Дополнительные флаги: `--dry-run`, `--debug`, `--only <id>`, `--reset-state`,
`--no-snapshots`, `--test-email`.

## Меню (menu.ps1)

| Клавиша | Действие |
|---|---|
| `1` | Полная проверка всех систем (daily) |
| `T` | Тестовая проверка (dry-run) |
| `2-10` | Отдельная система: Производство, Офис, Склад, Новый цех, Стройка, Цех выдува, BEWARD, iVMS, Ростелеком |
| `R` | Открыть последний отчёт |
| `V` | Live-монитор (auto-refresh 30 сек) |
| `H` | Отчёт за период (день / 3д / 7д / 30д / произвольно) |
| `L` | Папка логов |
| `S` | Настройка расписания |
| `E` | Email-адреса (Европласт / Онлайн / Helpdesk) |
| `G` | Управление камерами (gray / delete / **A** — добавить устройство) |
| `0` | Выход |

## Структура

```
autocamera/
├── menu.ps1                 интерактивное меню
├── setup-schedule.ps1       настройка задач Windows
├── AutoCamera.bat           ярлык для рабочего стола
├── .env                     секреты (не в git)
├── config/
│   ├── systems.json         список 9 систем + камер
│   └── schedule.json        расписание light + daily
├── src/
│   ├── index.js             оркестратор (light / daily / manual)
│   ├── reporter.js          HTML-отчёт + sendReport + helpdesk
│   ├── isapi.js             Hikvision/HiWatch ISAPI (digest auth)
│   ├── hikvision-multi.js   iVMS — per-camera ISAPI
│   ├── trassir-check.js     TRASSIR SDK HTTP API
│   ├── rtsp-check.js        iPanda — RTSP DESCRIBE
│   ├── tplink-tapo-check.js TP-Link Tapo — RTSP+ffmpeg (новое в v2.1)
│   ├── rostelecom-check.js  Портал РТ — Playwright
│   ├── beward-check.js      BEWARD SMB
│   ├── recordings-check.js  Стройка SMB + контроль качества
│   ├── snapshots.js         захват кадра по типу системы
│   ├── bitrix-disk.js       загрузка снимков в Bitrix24
│   ├── last-good.js         кэш последнего рабочего кадра
│   ├── timeline.js          журнал событий offline/online
│   ├── state.js             helpdesk-state и дедупликация
│   ├── period-report.js     CLI отчёта за период
│   ├── detect-device.js     автоопределение типа устройства
│   └── manage-cameras.mjs   CLI для меню (add/gray/delete)
├── state/                   helpdesk-state.json, timeline-*.json (не в git)
├── screenshots/last-good/   кэш миниатюр для отчётов
├── logs/                    дневные логи (хранятся 14 дней)
└── reports/                 HTML-отчёты + live.html
```

## Быстрый старт

```powershell
git clone git@github.com:alegis1337/autocamera.git
cd autocamera
npm install
Copy-Item .env.example .env       # затем заполнить креды
.\setup-schedule.ps1              # создать задачи Light + Daily в Планировщике
.\menu.ps1                        # интерактивное меню
```

Требования: Node.js 18+, ffmpeg, Playwright Chromium (`npm install` скачает
автоматически), сетевой доступ к камерам, inbound webhook в Bitrix24 для
заливки снимков.

## Документация

- [CLAUDE.md](CLAUDE.md) — техническая документация (архитектура, env, helpdesk-логика, extraCameras, Tapo)
- [autocamera-manual.docx](autocamera-manual.docx) — инструкция для сотрудников (как смотреть отчёты, добавить камеру, действия при поломке)
- [.env.example](.env.example) — шаблон конфигурации со всеми переменными окружения
- [README.txt](README.txt) — текстовая версия README для Notepad на VM

## Контакт

Ефремов Олег — техническая поддержка
`efremovoe@dc1c.ru` · +7 906 916-08-80

ГК «Цифровая Сибирь»
