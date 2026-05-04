# AutoCamera Monitor — инструкции для агента
**Версия:** v1.0 | **Проект:** `C:\Users\dsadmin\Desktop\autocamera`

Автоматизированный мониторинг камер: проверяет 9 систем (Европласт + Онлайн),
формирует HTML-отчёт, рассылает письма заказчику и helpdesk.
Запуск по расписанию через Планировщик задач Windows — **человек не наблюдает**.
Работа без интерактивных подтверждений и без ожидания ввода.

Все комментарии и логи — **только на русском**.

---

## Архитектура

Вместо браузера и AI-анализа картинок — прямые API и сетевые проверки:

```
AutoCamera Monitor (Node.js, ES modules)
│
├── Европласт (группа "Европласт")
│   ├── trassir          → TRASSIR SDK HTTP API (10.0.120.195:8080)
│   ├── ipanda-office    → RTSP DESCRIBE через NVR (10.0.120.192)
│   ├── hiwatch-sklad    → Hikvision ISAPI (10.0.120.30)
│   ├── ipanda-noviy-ceh → RTSP DESCRIBE через NVR (10.0.120.220)
│   ├── evroplast-stroyka→ SMB — проверка свежести файлов записи
│   └── hiwatch-vyduv    → Hikvision ISAPI (HIWATCH_VYDUV_*)
│
└── Онлайн (группа "Онлайн")
    ├── beward           → SMB freshness (порог 180 мин) + ping
    ├── ivms             → Hikvision ISAPI per-camera
    └── rostelecom       → портал lk-b2b.camera.rt.ru (Playwright headless)
```

Никакого облачного AI, никаких скриншотов для распознавания. Только
детерминированные запросы к API / SMB / RTSP / ISAPI. Ростелеком —
единственный случай, где нужен headless-браузер, т.к. у него нет открытого API.

---

## Окружение

| Элемент           | Значение                                               |
|-------------------|--------------------------------------------------------|
| ОС                | Windows 10/11 (ВМ)                                     |
| Runtime           | Node.js ≥ 20, ES modules                               |
| Корень проекта    | `C:\Users\dsadmin\Desktop\autocamera`                  |
| Секреты           | `.env` (см. `.env.example`)                            |
| Системы           | `config\systems.json` (9 систем, поле `group`)         |
| Настройки         | `config\settings.json`                                 |
| Запуск вручную    | `AutoCamera.bat` → `menu.ps1` (PowerShell UI)          |
| Запуск cron       | Windows Task Scheduler, `npm start`                    |

---

## Структура кода (`src/`)

| Файл                  | Назначение                                         |
|-----------------------|----------------------------------------------------|
| `index.js`            | Основной оркестратор: читает systems.json, диспатчит по `type`, собирает результаты, запускает отчёт |
| `reporter.js`         | Генерация HTML-отчёта заказчику + отдельные письма helpdesk по группам |
| `logger.js`           | Логгер (файл + консоль, уровни info/warn/error/debug) |
| `isapi.js`            | Hikvision/HiWatch ISAPI (digest auth, list каналов, статусы) |
| `hikvision-multi.js`  | iVMS — пер-камерный ISAPI                           |
| `trassir-check.js`    | TRASSIR SDK HTTP API (login, channels, signal, kbps)|
| `rtsp-check.js`       | iPanda — RTSP DESCRIBE через NVR                   |
| `beward-check.js`     | BEWARD — свежесть SMB-файлов + ping                |
| `recordings-check.js` | Европласт Стройка — свежесть файлов по SMB          |
| `smb-utils.js`        | Общие SMB-примитивы                                 |
| `rostelecom-check.js` | Портал РТ через headless Playwright                |

**Удалено в v1.0:** `analyzer.js` (polza.ai vision), `browser.js` (screenshot
MCP), `ping-check.js` (iPanda ping — заменён на RTSP). В коде не должно
оставаться упоминаний этих модулей или `POLZA_*` переменных.

---

## Поток выполнения

1. **Startup** — читаем `.env` и `config/systems.json`, создаём папки
   `logs/`, `reports/`.
2. **Проверка систем** — по очереди для каждой `enabled: true` системы:
   - диспатч по `sys.type` (trassir-sdk, ipanda-rtsp, hiwatch/hikvision,
     smb-recordings, beward-smb, hikvision-multi, rt-portal);
   - результат: `{ id, name, group, cameras: [...], error, aiSummary }`;
   - ошибка одной системы не валит весь прогон — продолжаем дальше.
3. **Отчёт** (`reporter.js`):
   - HTML-письмо заказчику со сводкой, цветной легендой, таблицами/гридами
     по каждой системе;
   - **отдельные** письма helpdesk: одно на группу ("Европласт", "Онлайн").
     Тема: `[HELPDESK] <группа> — проблемы камер DD.MM.YYYY (N шт.)`;
   - helpdesk игнорирует камеры из `sys.helpdeskIgnore` и
     `sys.unusedChannels`.
4. **Письмо** — `nodemailer` через SMTP (Яндекс). Для анти-спама задаются
   `Message-ID`, `text/plain` alternative, заголовок `X-Mailer`. При 550
   SPAM — логируем и сохраняем отчёт локально.
5. **Завершение** — `RUN_END | duration=… | systems=N | issues=N`, `exit 0/1`.

---

## Семантика статусов

| Значение `online` | Отображение      | Смысл                                      |
|-------------------|------------------|--------------------------------------------|
| `true`            | зелёный квадрат  | камера в сети, проверка прошла успешно     |
| `false`           | красный квадрат  | камера недоступна / API вернул ошибку      |
| `null`            | серый квадрат    | "не используется" / нет данных (из конфига)|
| `'unknown'`       | серый квадрат    | проверка не смогла дать достоверный ответ  |

В письме заказчика блок с цветной легендой размещён между системами и
футером — объясняет значение квадратов и суммарных бейджей `N/N online`.

---

## Правила для helpdesk-писем

- Пишем **по одному письму на группу**. Группа берётся из поля `group`
  конкретной системы (`"Европласт"` / `"Онлайн"`).
- Если в группе нет проблемных камер — письмо по ней не отправляется.
- Камеры, занесённые в `helpdeskIgnore` / `unusedChannels` своей системы,
  в helpdesk-письма не попадают.
- Для BEWARD "мерцание" (файлы появляются с паузами) — норма; в helpdesk
  попадают только длительно offline камеры (по freshness ≥ 180 мин).

---

## Переменные окружения

Полный список — в `.env.example`. Кратко:

- `SMTP_*`, `REPORT_TO`, `HELPDESK_TO` — почта.
- `TRASSIR_USER/PASS`.
- `HIWATCH_SKLAD_*`, `HIWATCH_VYDUV_*`.
- `STROYKA_SMB_USER/PASS`, `BEWARD_SMB_USER/PASS`.
- `IVMS_AERO_*`, `IVMS_T2_*`, `IVMS_MEGAFON_*`.
- `RT_PORTAL_URL/USER/PASS`.

**Больше не используются** (удалены из кода): `POLZA_API_KEY`,
`POLZA_MODEL`, `REPORT_FROM`, `NOVIY_CEH_*`, `TRASSIR_URL`, `IVMS_URL`,
`BEWARD_URL`.

---

## Правила поведения агента

- **Не** запрашивать интерактивный ввод.
- **Не** зависать: у каждого сетевого вызова должен быть таймаут.
- Ошибка одной камеры / системы — залогировать и продолжить.
- Критический сбой SMTP — сохранить отчёт локально, `exit 1`.
- Комментарии и сообщения логов — на русском.
- Никогда не ломать обратную совместимость полей результата (`cameras[i].online`,
  `recording`, `audio`, `notes`, `index`) — их читает `reporter.js`.

---

## Актуальная версия

**v1.0** — зафиксирована в `menu.ps1` (`$Version = "v1.0"`) и отображается
в шапке меню. При значимых изменениях поведения/набора систем — бамп
версии и обновление этого файла.
