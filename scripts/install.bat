@echo off
REM ════════════════════════════════════════════
REM  AutoCamera Monitor — Install Script
REM ════════════════════════════════════════════
REM
REM  Что нужно ПЕРЕД запуском этого скрипта:
REM    1. Установить Node.js v18+ (https://nodejs.org — LTS)
REM    2. Скачать проект с GitHub
REM    3. Запустить этот скрипт
REM

echo ============================================
echo  AutoCamera Monitor — Installation
echo ============================================
echo.

REM ─── Проверка Node.js ───────────────────────
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Node.js не найден!
    echo.
    echo   Установи Node.js v18+ с https://nodejs.org
    echo   Выбери LTS версию, при установке отметь "Add to PATH"
    echo.
    pause
    exit /b 1
)

for /f "tokens=*" %%i in ('node --version') do set NODE_VER=%%i
echo [OK] Node.js найден: %NODE_VER%
echo.

REM ─── Переход в папку проекта ────────────────
cd /d "%~dp0.."
echo Рабочая папка: %CD%
echo.

REM ─── Шаг 1: npm install ────────────────────
echo [1/4] Установка зависимостей (npm install)...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] npm install не удался
    pause
    exit /b 1
)
echo [OK] Зависимости установлены
echo.

REM ─── Шаг 2: Playwright Chromium ─────────────
echo [2/4] Установка браузера Chromium (~400 МБ)...
call npx playwright install chromium
if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Playwright install не удался
    pause
    exit /b 1
)
echo [OK] Chromium установлен
echo.

REM ─── Шаг 3: Создание .env ──────────────────
echo [3/4] Создание .env...
if not exist .env (
    copy .env.example .env >nul
    echo [OK] .env создан из шаблона — ЗАПОЛНИ реальными данными!
) else (
    echo [OK] .env уже существует — пропускаем
)
echo.

REM ─── Шаг 4: Создание папок ─────────────────
echo [4/4] Создание рабочих папок...
if not exist screenshots mkdir screenshots
if not exist reports mkdir reports
if not exist logs mkdir logs
echo [OK] Папки созданы
echo.

REM ─── Итог ───────────────────────────────────
echo ============================================
echo  Установка завершена!
echo.
echo  Что заполнить в .env:
echo    - POLZA_API_KEY  (ключ от polza.ai)
echo    - NOVIY_CEH_PASS (пароль iPanda)
echo    - HIWATCH_SKLAD_PASS (пароль HiWatch)
echo    - SMTP_USER / SMTP_PASS (для email)
echo.
echo  Команды для тестирования:
echo    npm run dry-run              — проверить все системы (без email)
echo    node src/index.js --dry-run --only noviy-ceh  — только новый цех
echo    npm run test-email           — тестовый email
echo    npm start                    — полный запуск
echo ============================================
pause
