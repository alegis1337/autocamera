# setup-schedule.ps1 — Setup Windows Task Scheduler for AutoCamera

param(
    [switch]$Remove
)

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $ProjectDir "config\schedule.json"

if (-not (Test-Path $ConfigPath)) {
    Write-Host "  Error: config not found $ConfigPath" -ForegroundColor Red
    exit 1
}

$config = Get-Content $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
$TaskName = $config.taskName

# Remove task
if ($Remove) {
    $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "  Task '$TaskName' removed." -ForegroundColor Green
    } else {
        Write-Host "  Task '$TaskName' not found." -ForegroundColor Yellow
    }
    exit 0
}

# Parse start time (MSK -> local)
$mskParts = $config.startTimeMSK -split ':'
$mskHour = [int]$mskParts[0]
$mskMin  = [int]$mskParts[1]

$localUtcOffset = [int][System.TimeZoneInfo]::Local.BaseUtcOffset.TotalHours
$mskUtcOffset = 3
$diffHours = $localUtcOffset - $mskUtcOffset
$localHour = [int]($mskHour + $diffHours)

if ($localHour -lt 0)  { $localHour += 24 }
if ($localHour -ge 24) { $localHour -= 24 }

$startTime = $localHour.ToString("00") + ":" + $mskMin.ToString("00")

Write-Host ""
Write-Host "  === AutoCamera Schedule Setup ===" -ForegroundColor Cyan
Write-Host "  Start time (MSK):   $($config.startTimeMSK)" -ForegroundColor White
Write-Host "  Start time (local): $startTime" -ForegroundColor White

$intervalH = [int]$config.intervalHours
$intervalM = [int]$config.intervalMinutes
$totalIntervalMin = $intervalH * 60 + $intervalM

if ($totalIntervalMin -gt 0) {
    Write-Host "  Repeat interval:    ${intervalH}h ${intervalM}m" -ForegroundColor White
} else {
    Write-Host "  Mode:               once a day" -ForegroundColor White
}
Write-Host ""

# Action — run node src/index.js
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "  Error: node.exe not found in PATH" -ForegroundColor Red
    exit 1
}

$action = New-ScheduledTaskAction `
    -Execute $nodeExe `
    -Argument "src/index.js" `
    -WorkingDirectory $ProjectDir

# Trigger
$trigger = New-ScheduledTaskTrigger -Daily -At $startTime

# Repetition interval
if ($totalIntervalMin -gt 0) {
    $trigger.Repetition = New-Object Microsoft.Management.Infrastructure.CimInstance 'MSFT_TaskRepetitionPattern','root/Microsoft/Windows/TaskScheduler'
    $trigger.Repetition.Interval = "PT${totalIntervalMin}M"
    $trigger.Repetition.Duration = "P1D"
    $trigger.Repetition.StopAtDurationEnd = $false
}

# Settings
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
    -RestartCount 2 `
    -RestartInterval (New-TimeSpan -Minutes 5)

# Remove old task if exists
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "  Old task removed." -ForegroundColor DarkGray
}

# Create task
Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "AutoCamera Monitor - automatic camera check" `
    -RunLevel Highest | Out-Null

Write-Host "  Task '$TaskName' created!" -ForegroundColor Green

if ($totalIntervalMin -gt 0) {
    Write-Host "  First run: $startTime, repeat every ${intervalH}h ${intervalM}m" -ForegroundColor Green
} else {
    Write-Host "  Daily run at $startTime" -ForegroundColor Green
}

Write-Host ""
Write-Host "  Check:  Get-ScheduledTask -TaskName '$TaskName'" -ForegroundColor DarkGray
Write-Host "  Remove: .\setup-schedule.ps1 -Remove" -ForegroundColor DarkGray
Write-Host ""
