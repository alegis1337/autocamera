# AutoCamera v2 — тестовая среда

**Эта папка — тестовая копия проекта.** Прод-версия живёт в
`C:\Users\dsadmin\Desktop\autocamera\` и крутится через scheduled task
`AutoCamera Monitor`. Здесь — разработка v2 без риска для прод-системы.

## Структура

| Что | v1 (прод) | v2 (тест) |
|---|---|---|
| Папка | `C:\Users\dsadmin\Desktop\autocamera\` | `C:\Users\dsadmin\Desktop\autocamera-v2\` |
| Git ветка | `main` (тег `v1.0`) | `v2-dev` |
| Scheduled task | `AutoCamera Monitor` | **нет** (только ручной запуск) |
| `.env` получатели | реальные клиенты | `alegis1337@gmail.com` |
| `HELPDESK_TO` | `helpdesk@dc1c.ru` | пусто (заявки не идут) |
| Битрикс webhook | прод-вебхук + папка `AutoCamera` | dev-вебхук + папка `AutoCamera-test` |
| `TEST_MODE` | unset | `true` |

Папка v2 — это **git worktree**, не отдельный клон. У них общий `.git`.

## Запуск

```powershell
cd C:\Users\dsadmin\Desktop\autocamera-v2

# Тест одной системы (iVMS — 3 камеры, ~7 сек)
node src/index.js --dry-run --only ivms

# Все 9 систем без отправки email
node src/index.js --dry-run

# Полный прогон с отправкой на alegis1337@gmail.com (без helpdesk)
node src/index.js
```

При старте index.js печатает баннер `*** TEST MODE — v2 DEV ENV ***` со
списком текущих получателей — двойная проверка перед отправкой.

## Workflow

1. Все фичи v2 — только в этой папке (ветка `v2-dev`).
2. Каждая готовая фича — отдельный коммит в `v2-dev`.
3. Когда все фичи готовы и протестированы:
   - `git checkout main`
   - `git merge v2-dev`
   - `git tag v2.0`
   - В проде: `git pull && npm install`
   - Скорректировать прод `.env` (`YANDEX_DISK_TOKEN`, `YANDEX_DISK_ROOT=/AutoCamera`).
4. Если что-то сломалось — `git checkout v1.0` восстанавливает baseline.

## Откат

Если ветка `v2-dev` зашла в тупик:

```powershell
cd C:\Users\dsadmin\Desktop\autocamera
git worktree remove C:\Users\dsadmin\Desktop\autocamera-v2 --force
git branch -D v2-dev
# Можно начать заново: git worktree add C:\Users\dsadmin\Desktop\autocamera-v2 -b v2-dev v1.0
```

## План реализации v2

См. `C:\Users\dsadmin\.claude\plans\bubbly-gliding-trinket.md` —
утверждённый заказчиком план из 4 фич:

1. **State + dedupe** — заявки в helpdesk только при смене статуса.
2. **Diagnose** — активная диагностика причин падения.
3. **Snapshots + Битрикс Диск** — кадры с камер в облаке.
4. **Live-monitor** — `reports/live.html` с auto-refresh.

Реализуются в указанном порядке.

## Что НЕ менять во время работы над v2

- Ничего в `C:\Users\dsadmin\Desktop\autocamera\` (это прод).
- Scheduled task `AutoCamera Monitor`.
- Тег `v1.0`.
