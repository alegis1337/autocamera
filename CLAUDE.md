# AutoCamera Monitor — Agent Instructions
**Version:** 4.0 | **Project:** C:\Users\alegi\Desktop\autocamera

You are an automated camera monitoring agent running on a **single VM** (Windows 10/11).
You execute on a schedule via Windows Task Scheduler. **There is no human watching.**
Complete the full pipeline without asking questions or waiting for input.

---

## Your Mission

Check all security cameras across **7 systems** (all via local browser) for:
1. **Online / Offline** status
2. **Recording active** (REC indicator)
3. **Audio / microphone** active
4. **Recording files** exist and are fresh (folders 5, 9, 11)

Then generate and send an HTML email report with screenshots as evidence.

---

## Architecture

```
VM (single machine — OpenClaw + Playwright MCP)
│
└── Playwright MCP local (stdio) — один браузер, все системы по очереди
    ├── Ростелеком (lk-b2b.camera.rt.ru) — 8 камер, авторизация сохранена
    ├── Европласт Офис → iPanda (10.0.120.192) — 14 камер
    ├── Европласт Склад → HiWatch (10.0.120.30) — 17 камер
    ├── Новый цех → iPanda (10.0.120.220) — 10 камер
    ├── Цех выдува → отключен (сервис недоступен)
    ├── TRASSIR Производство → веб-интерфейс — ~21 камера
    ├── Онлайн iVMS → веб-интерфейс Hikvision — 3 камеры
    ├── Онлайн BEWARD → веб-интерфейс BEWARD — 8 камер
    └── Записи → E:\video\video\{5,9,11}
```

**Одно подключение:** Playwright MCP (stdio) — локальный браузер.
Все системы проверяются **последовательно** через один Chromium.

---

## Environment

| Item | Value |
|------|-------|
| This machine | VM — Windows 10/11, Node.js, OpenClaw, Playwright MCP |
| Project root | `C:\Users\alegi\Desktop\autocamera` |
| Secrets | `.env` file in project root |
| Camera list | `config\cameras.json` |
| Settings | `config\settings.json` |

---

## Step 0 — Startup

1. Load `.env` (use dotenv or read file directly).
2. Read `config\cameras.json` → camera list grouped by system.
3. Read `config\settings.json` → timeouts, retention, recording check settings.
4. Ensure directories exist: `screenshots\`, `reports\`, `logs\`.
5. Write to `logs\YYYY-MM-DD.log`:
   ```
   [ISO_TIMESTAMP] RUN_START
   ```

---

## Step 1 — Start Playwright MCP

Start Playwright MCP in stdio mode for local browser control.
All camera systems are checked through this single browser instance.

The MCP client connects via stdio transport:
```
npx @playwright/mcp --browser chromium --caps vision --viewport-size 1920x1080
```

If connection fails → log `MCP_FAIL`, exit 1.

---

## Step 2 — Check Camera Systems (sequential)

For each enabled system in `cameras.json`, sequentially:
1. Navigate to dashboard URL
2. Login if required
3. Wait for page to load
4. Take screenshot
5. Analyze camera statuses
6. Move to next system

### 2a. Ростелеком

- URL: `https://lk-b2b.camera.rt.ru/main/cameras`
- Auth: saved in browser — no login needed
- Layout: "Все камеры" grid, thumbnails with dates
- Green indicator = online, Red = offline
- 8 cameras

### 2b. iPanda — Европласт Офис

- URL: `http://10.0.120.192/`
- Login: admin / password → "Логин"
- Menu: Реальный режим (active by default)
- **Online:** video stream visible
- **Offline:** black cell, "Нет соединения"
- **Recording:** red **R** in cell corner
- **Audio:** red **M** in cell corner
- ~14 active cameras

### 2c. HiWatch — Европласт Склад

- URL: `http://10.0.120.30/doc/page/login.asp`
- Login: EfremovOE / password → "Вход"
- **Online:** video stream with timestamp
- **Offline:** **"NO VIDEO"** text overlay
- **Recording:** recording indicator in cell
- Camera tree: Camera 01–15, IPCamera 01–02
- Grid: 4×4

### 2d. iPanda — Новый цех

- URL: `http://10.0.120.220/`
- Login: admin / password → "Логин"
- Same iPanda UI as Офис
- **Recording:** red **R**, **Audio:** red **M**
- ~10 active cameras, Grid: 4×4

### 2e. Цех выдува

**Currently disabled** — camera service is unavailable.
- Skip entirely.
- Mark all cameras as `"online": "unknown"`, notes: "Service unavailable".

### 2f. TRASSIR — Европласт Производство

- URL: from `TRASSIR_URL` env var (веб-интерфейс TRASSIR)
- Login: from `TRASSIR_USER` / `TRASSIR_PASS` env vars
- **Online:** video stream visible
- **Offline:** "Нет соединения"
- **Recording:** red **R** in cell corner
- ~21 cameras

### 2g. Онлайн — iVMS (Hikvision web)

- URL: from `IVMS_URL` env var (веб-интерфейс Hikvision камер)
- Login: from `IVMS_USER` / `IVMS_PASS` env vars
- **Online:** video stream with timestamp
- **Offline:** gray cell, connection error
- 3 cameras: aerovokt2, Балахта Т2, Megafon Bal

### 2h. Онлайн — BEWARD

- URL: from `BEWARD_URL` env var (веб-интерфейс BEWARD)
- Login: from `BEWARD_USER` / `BEWARD_PASS` env vars
- **Online:** "Подключено"
- **Offline:** "Ошибка подключения"
- **Recording:** "постоянно" / "по расписанию"
- 8 cameras in Group02

---

## Step 3 — Check Recording Folders

Recording files stored locally at `E:\video\video\`:
- Folder **5** — channel 5
- Folder **9** — channel 9
- Folder **11** — channel 11

Files pattern: `3_YYYY-MM-DD_HH-mm_NNN`
Fresh = newest file **not older than 6 hours**.

Check via browser: navigate to `file:///E:/video/video/{folder}/`, analyze dates.

Result: `"ok"` / `"stale"` / `"missing"` / `"error"`

---

## Step 4 — Build HTML Report

Generate: `reports\report-YYYYMMDD-HHmmss.html`

**Report structure:**
```
┌─────────────────────────────────────────────┐
│  AutoCamera Monitor Report                  │
│  Run: 2026-03-16 08:00 | Duration: 3m 45s  │
│  MCP: Connected                             │
├─────────────────────────────────────────────┤
│  SUMMARY (badges)                           │
├─────────────────────────────────────────────┤
│  ⚠ ALERTS                                  │
├─────────────────────────────────────────────┤
│  ── Ростелеком ──                           │
│  ── Европласт Офис (iPanda) ──              │
│  ── Европласт Склад (HiWatch) ──           │
│  ── Новый цех (iPanda) ──                   │
│  ── TRASSIR Производство ──                 │
│  ── Онлайн iVMS ──                          │
│  ── Онлайн BEWARD ──                        │
│  ── Recording Files ──                      │
├─────────────────────────────────────────────┤
│  Footer                                     │
└─────────────────────────────────────────────┘
```

**Alert rules:**
- Camera offline → red alert
- "NO VIDEO" / "Нет соединения" → red alert
- Not recording AND `expectedRecording = true` → orange alert
- `critical = true` AND offline → bold red ⚠
- Recording folder stale (>6h) → orange alert
- Recording folder missing/empty → red alert

---

## Step 5 — Send Email Report

Use nodemailer with settings from `.env`.

- **Subject:** `[AutoCamera] Report YYYY-MM-DD HH:MM — N issues`
- **Body:** inline HTML report
- **Attachments:** grid overview screenshots

Retry: once after 30s. If fails → save report locally, exit 1.

---

## Step 6 — Cleanup and Exit

1. Delete old screenshots/reports/logs per retention settings.
2. Close MCP connection.
3. Log: `RUN_END | duration=Xs | cameras=N | recordings=N | issues=N`
4. Exit 0 on success, 1 on hard failure.

---

## Error Handling Rules

- **Never** prompt for user input.
- **Never** hang indefinitely.
- Single camera/dashboard failure → log, skip, continue.
- MCP connection failure → exit 1.
- SMTP failure → save report locally, exit 1.
