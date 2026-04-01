@echo off
REM AutoCamera Monitor — Task Scheduler entry point

cd /d "C:\Users\alegi\Desktop\autocamera"
echo [%DATE% %TIME%] Run started >> logs\scheduler.log
node src\index.js >> logs\scheduler.log 2>&1
if %ERRORLEVEL% EQU 0 (
    echo [%DATE% %TIME%] Run OK >> logs\scheduler.log
) else (
    echo [%DATE% %TIME%] Run FAILED (exit %ERRORLEVEL%) >> logs\scheduler.log
)
