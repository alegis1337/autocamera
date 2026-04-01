# AutoCamera Monitor

Автоматическая проверка камер видеонаблюдения с помощью ИИ.

Скрипт открывает веб-интерфейсы камер через Playwright, делает скриншоты, анализирует через AI (polza.ai) и отправляет HTML-отчёт на email.

## Требования

- **Node.js v18+** — https://nodejs.org (LTS версия)
- **Windows 10/11 x64**
- **4 ГБ RAM** (рекомендуется 6 ГБ)
- Доступ к камерам по сети (iPanda, HiWatch)
- API ключ от [polza.ai](https://polza.ai)

## Установка

```bat
git clone <repo-url>
cd autocamera
scripts\install.bat
```

Скрипт установит зависимости, Chromium и создаст `.env`.

## Настройка

Заполни `.env`:
```env
POLZA_API_KEY=ваш_ключ_polza_ai
NOVIY_CEH_PASS=пароль_ipanda
HIWATCH_SKLAD_PASS=пароль_hiwatch
SMTP_USER=email@gmail.com
SMTP_PASS=app_password
REPORT_TO=admin@company.com
```

## Запуск

```bat
npm run dry-run                                   # проверка без email
node src/index.js --dry-run --only noviy-ceh      # только одна система
npm run test-email                                # тестовый email
npm start                                         # полный запуск с email
node src/index.js --debug                         # подробные логи
```

## Как работает

1. Playwright открывает веб-интерфейс камеры в Chromium
2. Логинится → делает скриншот
3. Скриншот отправляется в polza.ai (AI vision)
4. AI возвращает статус каждой камеры (online/offline/recording)
5. Строится HTML-отчёт → отправляется на email

## Структура

```
src/
  index.js      — главный пайплайн
  browser.js    — Playwright: браузер, логин, скриншот
  analyzer.js   — polza.ai API: анализ скриншотов
  reporter.js   — HTML-отчёт + email
  logger.js     — система логирования
config/
  systems.json  — список камерных систем
scripts/
  install.bat   — установка
  run.bat       — запуск через Task Scheduler
```

## Логи

Логи пишутся в `logs/YYYY-MM-DD.log` с указанием:
- Какой шаг выполняется
- Сколько времени занял каждый шаг
- Какие камеры offline / не записывают
- Ошибки с контекстом
