# AutoCamera Monitor
$ProjectDir = "C:\Users\dsadmin\Desktop\autocamera"
$Version    = "v1.0.1"
Set-Location $ProjectDir

function Get-EnvValue {
    param($Key)
    $envFile = Join-Path $ProjectDir ".env"
    $lines = Get-Content $envFile -Encoding UTF8
    foreach ($line in $lines) {
        if ($line -match "^${Key}=(.*)$") { return $Matches[1] }
    }
    return ""
}

function Set-EnvValue {
    param($Key, $Value)
    $envFile = Join-Path $ProjectDir ".env"
    $lines = Get-Content $envFile -Encoding UTF8
    $found = $false
    $newLines = @()
    foreach ($line in $lines) {
        if ($line -match "^${Key}=") {
            $newLines += "${Key}=${Value}"
            $found = $true
        } else {
            $newLines += $line
        }
    }
    if (-not $found) { $newLines += "${Key}=${Value}" }
    $newLines | Set-Content $envFile -Encoding UTF8
}

function Show-Menu {
    Clear-Host

    $reportEvroplast = Get-EnvValue "REPORT_TO_EVROPLAST"
    $reportOnline    = Get-EnvValue "REPORT_TO_ONLINE"
    $reportFallback  = Get-EnvValue "REPORT_TO"
    $helpdeskTo      = Get-EnvValue "HELPDESK_TO"
    if (-not $reportEvroplast) { $reportEvroplast = "$reportFallback (fallback)" }
    if (-not $reportOnline)    { $reportOnline    = "$reportFallback (fallback)" }

    $schedulePath = Join-Path $ProjectDir "config\schedule.json"
    $schedInfo = "ne nastroeno"
    if (Test-Path $schedulePath) {
        $sch = Get-Content $schedulePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $intH = [int]$sch.intervalHours
        $intM = [int]$sch.intervalMinutes
        if ($intH -gt 0 -or $intM -gt 0) {
            $schedInfo = "$($sch.startTimeMSK) MSK, kazhdye ${intH}ch ${intM}min"
        } else {
            $schedInfo = "$($sch.startTimeMSK) MSK, odin raz v den"
        }
        $taskName = $sch.taskName
        $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($existing) {
            $schedInfo += " [AKTIVNO]"
        } else {
            $schedInfo += " [ne primeneno]"
        }
    }

    Write-Host ""
    $title = "  |        AutoCamera Monitor  $Version          |"
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host $title -ForegroundColor Cyan
    Write-Host "  +------------------------------------------+" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Otchet Evroplast: " -NoNewline -ForegroundColor Gray
    Write-Host "$reportEvroplast" -ForegroundColor DarkCyan
    Write-Host "  Otchet Online:    " -NoNewline -ForegroundColor Gray
    Write-Host "$reportOnline" -ForegroundColor DarkCyan
    Write-Host "  Helpdesk:         " -NoNewline -ForegroundColor Gray
    Write-Host "$helpdeskTo" -ForegroundColor DarkCyan
    Write-Host "  Zapusk:    " -NoNewline -ForegroundColor Gray
    Write-Host "$schedInfo" -ForegroundColor DarkCyan
    Write-Host ""
    Write-Host "   1  Proverit VSE sistemy " -NoNewline -ForegroundColor White
    Write-Host "(s otpravkoy email)" -ForegroundColor DarkGray
    Write-Host "   T  Testovaya proverka VSEKH " -NoNewline -ForegroundColor Yellow
    Write-Host "(bez otpravki email)" -ForegroundColor DarkGray
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    Write-Host "   --- EVROPLAST ---" -ForegroundColor Cyan
    Write-Host "   2  Proizvodstvo   " -NoNewline -ForegroundColor White
    Write-Host "(TRASSIR)" -ForegroundColor DarkGray
    Write-Host "   3  Ofis           " -NoNewline -ForegroundColor White
    Write-Host "(iPanda)" -ForegroundColor DarkGray
    Write-Host "   4  Sklad          " -NoNewline -ForegroundColor White
    Write-Host "(HiWatch)" -ForegroundColor DarkGray
    Write-Host "   5  Novyy ceh      " -NoNewline -ForegroundColor White
    Write-Host "(iPanda)" -ForegroundColor DarkGray
    Write-Host "   6  Stroyka        " -NoNewline -ForegroundColor White
    Write-Host "(zapisi, SMB)" -ForegroundColor DarkGray
    Write-Host "   7  Ceh vyduva     " -NoNewline -ForegroundColor White
    Write-Host "(HiWatch)" -ForegroundColor DarkGray
    Write-Host "   --- ONLINE ---" -ForegroundColor Cyan
    Write-Host "   8  BEWARD         " -NoNewline -ForegroundColor White
    Write-Host "(udalyonnye, SMB)" -ForegroundColor DarkGray
    Write-Host "   9  iVMS           " -NoNewline -ForegroundColor White
    Write-Host "(Hikvision)" -ForegroundColor DarkGray
    Write-Host "  10  Rostelecom     " -NoNewline -ForegroundColor White
    Write-Host "(portal)" -ForegroundColor DarkGray
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    Write-Host "   R  Otkryt posledniy otchet" -ForegroundColor Yellow
    Write-Host "   L  Otkryt logi" -ForegroundColor Yellow
    Write-Host "   --------------------------------" -ForegroundColor DarkGray
    Write-Host "   S  Nastroit raspisanie" -ForegroundColor Magenta
    Write-Host "   E  Nastroit email-adresa" -ForegroundColor Magenta
    Write-Host "   G  Upravlenie serym markerom kamer" -ForegroundColor Magenta
    Write-Host ""
    Write-Host "   0  Vyhod" -ForegroundColor DarkGray
    Write-Host ""
    Write-Host ""
    Write-Host ""
}

function Setup-Schedule {
    $configPath = Join-Path $ProjectDir "config\schedule.json"
    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json

    Clear-Host
    Write-Host ""
    Write-Host "  === Nastroyka raspisaniya ===" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  Tekushchie nastroyki:" -ForegroundColor White
    Write-Host "    Vremya zapuska (MSK): $($config.startTimeMSK)" -ForegroundColor Gray
    $intH = [int]$config.intervalHours
    $intM = [int]$config.intervalMinutes
    if ($intH -gt 0 -or $intM -gt 0) {
        Write-Host "    Interval: kazhdye ${intH}ch ${intM}min" -ForegroundColor Gray
    } else {
        Write-Host "    Rezhim: odin raz v den" -ForegroundColor Gray
    }

    $taskName = $config.taskName
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "    Zadacha v planirovshchike: DA" -ForegroundColor Green
    } else {
        Write-Host "    Zadacha v planirovshchike: NET" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "  1  Izmenit vremya zapuska" -ForegroundColor White
    Write-Host "  2  Izmenit interval" -ForegroundColor White
    Write-Host "  3  Primenit raspisanie (sozdat zadachu)" -ForegroundColor Green
    Write-Host "  4  Udalit zadachu iz planirovshchika" -ForegroundColor Red
    Write-Host "  0  Nazad" -ForegroundColor DarkGray
    Write-Host ""

    $ch = Read-Host "  Vyberi punkt"
    switch ($ch) {
        "1" {
            $newTime = Read-Host "  Vremya zapuska MSK (naprimer 10:00)"
            if ($newTime -match '^\d{1,2}:\d{2}$') {
                $config.startTimeMSK = $newTime
                $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
                Write-Host "  Vremya izmeneno na $newTime MSK" -ForegroundColor Green
            } else {
                Write-Host "  Nevernyy format" -ForegroundColor Red
            }
        }
        "2" {
            Write-Host "  Primery: 0 = odin raz v den, 4 = kazhdye 4 chasa, 0.5 = kazhdye 30 min" -ForegroundColor Gray
            $val = Read-Host "  Interval v chasakh (0 = otklyuchit)"
            try {
                $hours = [double]$val
                $config.intervalHours = [math]::Floor($hours)
                $config.intervalMinutes = [int](($hours - [math]::Floor($hours)) * 60)
                $config | ConvertTo-Json | Set-Content $configPath -Encoding UTF8
                if ($hours -eq 0) {
                    Write-Host "  Rezhim: odin raz v den" -ForegroundColor Green
                } else {
                    Write-Host "  Interval: kazhdye $($config.intervalHours)ch $($config.intervalMinutes)min" -ForegroundColor Green
                }
            } catch {
                Write-Host "  Nevernyy format" -ForegroundColor Red
            }
        }
        "3" {
            Write-Host ""
            Write-Host "  Sozdayu zadachu..." -ForegroundColor Cyan
            & powershell.exe -ExecutionPolicy Bypass -File "$ProjectDir\setup-schedule.ps1"
        }
        "4" {
            Write-Host ""
            & powershell.exe -ExecutionPolicy Bypass -File "$ProjectDir\setup-schedule.ps1" -Remove
        }
    }
    Write-Host ""
    Read-Host "  Enter - nazad"
}

function Set-EmailAddress {
    param($Key, $Label)
    Write-Host ""
    Write-Host "  Mozhno ukazat neskolko adresov cherez zapyatuyu (naprimer: a@x.ru, b@x.ru)" -ForegroundColor Gray
    Write-Host "  Pustaya stroka = ubrat znachenie (budet ispolzovatsya fallback REPORT_TO)" -ForegroundColor DarkGray
    $new = Read-Host "  Novyy adres ($Label)"
    if (-not $new) {
        Set-EnvValue $Key ""
        Write-Host "  ${Label}: znachenie ochishcheno" -ForegroundColor Yellow
        return
    }
    # Проверяем, что в каждом адресе (через запятую) есть @
    $parts = $new.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }
    $bad = $parts | Where-Object { $_ -notmatch '@' }
    if ($bad) {
        Write-Host "  Nevernyy format email v: $($bad -join ', ')" -ForegroundColor Red
        return
    }
    $clean = ($parts -join ',')
    Set-EnvValue $Key $clean
    Write-Host "  ${Label}: $clean" -ForegroundColor Green
}

function Setup-Email {
    while ($true) {
        $reportEvroplast = Get-EnvValue "REPORT_TO_EVROPLAST"
        $reportOnline    = Get-EnvValue "REPORT_TO_ONLINE"
        $reportFallback  = Get-EnvValue "REPORT_TO"
        $helpdeskTo      = Get-EnvValue "HELPDESK_TO"

        Clear-Host
        Write-Host ""
        Write-Host "  === Nastroyka email-adresov ===" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Tekushchie adresa:" -ForegroundColor White
        Write-Host "    Otchet Evroplast:    " -NoNewline -ForegroundColor Gray
        if ($reportEvroplast) {
            Write-Host "$reportEvroplast" -ForegroundColor DarkCyan
        } else {
            Write-Host "(ispolzuetsya fallback: $reportFallback)" -ForegroundColor DarkGray
        }
        Write-Host "    Otchet Online:       " -NoNewline -ForegroundColor Gray
        if ($reportOnline) {
            Write-Host "$reportOnline" -ForegroundColor DarkCyan
        } else {
            Write-Host "(ispolzuetsya fallback: $reportFallback)" -ForegroundColor DarkGray
        }
        Write-Host "    Fallback REPORT_TO:  " -NoNewline -ForegroundColor Gray
        Write-Host "$reportFallback" -ForegroundColor DarkGray
        Write-Host "    Helpdesk:            " -NoNewline -ForegroundColor Gray
        Write-Host "$helpdeskTo" -ForegroundColor DarkCyan
        Write-Host ""
        Write-Host "  1  Izmenit adresa EVROPLAST (otchet)" -ForegroundColor White
        Write-Host "  2  Izmenit adresa ONLINE    (otchet)" -ForegroundColor White
        Write-Host "  3  Izmenit adresa HELPDESK" -ForegroundColor White
        Write-Host "  4  Izmenit fallback REPORT_TO" -ForegroundColor DarkGray
        Write-Host "  0  Nazad" -ForegroundColor DarkGray
        Write-Host ""

        $ch = Read-Host "  Vyberi punkt"
        switch ($ch) {
            "1" { Set-EmailAddress "REPORT_TO_EVROPLAST" "Evroplast"; Write-Host ""; Read-Host "  Enter..." }
            "2" { Set-EmailAddress "REPORT_TO_ONLINE"    "Online";    Write-Host ""; Read-Host "  Enter..." }
            "3" { Set-EmailAddress "HELPDESK_TO"         "Helpdesk";  Write-Host ""; Read-Host "  Enter..." }
            "4" { Set-EmailAddress "REPORT_TO"           "Fallback";  Write-Host ""; Read-Host "  Enter..." }
            "0" { return }
            default { }
        }
    }
}

function Manage-OneSystem {
    param($SysId, $SysName)

    while ($true) {
        Clear-Host
        Write-Host ""
        Write-Host "  === Seryy marker: $SysName ($SysId) ===" -ForegroundColor Cyan
        Write-Host ""

        $raw = & node "$ProjectDir\src\manage-gray.mjs" list $SysId 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $raw" -ForegroundColor Red
            Read-Host "  Enter - nazad"
            return
        }

        $items = @()
        foreach ($line in $raw) {
            if ($line -match '^(\d+)\|(.+)\|(gray|active)\|(name|channel)$') {
                $items += [pscustomobject]@{
                    Pos    = [int]$Matches[1]
                    Label  = $Matches[2]
                    Status = $Matches[3]
                    Kind   = $Matches[4]
                }
            }
        }

        if ($items.Count -eq 0) {
            Write-Host "  Net kamer dlya etoy sistemy" -ForegroundColor Yellow
            Read-Host "  Enter - nazad"
            return
        }

        $grayCount   = ($items | Where-Object { $_.Status -eq 'gray' }).Count
        $activeCount = $items.Count - $grayCount
        Write-Host "  Vsego kamer: $($items.Count)   |   Aktivnyh: $activeCount   |   Seryh: $grayCount" -ForegroundColor White
        Write-Host ""

        foreach ($it in $items) {
            $num = "{0,3}" -f $it.Pos
            if ($it.Status -eq 'gray') {
                Write-Host "  $num  [SERAYA] " -NoNewline -ForegroundColor DarkGray
                Write-Host "$($it.Label)" -ForegroundColor DarkGray
            } else {
                Write-Host "  $num  [aktiv]  " -NoNewline -ForegroundColor Green
                Write-Host "$($it.Label)" -ForegroundColor White
            }
        }

        Write-Host ""
        Write-Host "  Vvedite nomer kamery dlya pereklyucheniya statusa, ili 0 - nazad" -ForegroundColor Gray
        $ans = Read-Host "  Nomer"
        if ($ans -eq "0" -or -not $ans) { return }
        if ($ans -notmatch '^\d+$') {
            Write-Host "  Nuzhno chislo" -ForegroundColor Red
            Start-Sleep -Seconds 1
            continue
        }

        $result = & node "$ProjectDir\src\manage-gray.mjs" toggle $SysId $ans 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $result" -ForegroundColor Red
            Read-Host "  Enter..."
            continue
        }

        $resStr = ($result -join "`n")
        if ($resStr -match '^(grayed|activated)\|(.+)$') {
            $action = $Matches[1]
            $label  = $Matches[2]
            if ($action -eq 'grayed') {
                Write-Host "  Kamera '$label' pomechena SERYM (otslezhivanie otklyucheno)" -ForegroundColor Yellow
            } else {
                Write-Host "  Kamera '$label' AKTIVIROVANA (otslezhivanie vklyucheno)" -ForegroundColor Green
            }
        } else {
            Write-Host "  $resStr" -ForegroundColor Yellow
        }
        Start-Sleep -Seconds 1
    }
}

function Manage-GrayCameras {
    while ($true) {
        Clear-Host
        Write-Host ""
        Write-Host "  === Upravlenie serym markerom kamer ===" -ForegroundColor Cyan
        Write-Host ""
        Write-Host "  Seraya kamera = ne otslezhivaetsya v otchete i ne sozdaet zayavki v helpdesk" -ForegroundColor DarkGray
        Write-Host ""

        $raw = & node "$ProjectDir\src\manage-gray.mjs" list-systems 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  Oshibka: $raw" -ForegroundColor Red
            Read-Host "  Enter - nazad"
            return
        }

        $systems = @()
        foreach ($line in $raw) {
            if ($line -match '^([^|]+)\|([^|]+)\|(\d+)\|(\d+)$') {
                $systems += [pscustomobject]@{
                    Id    = $Matches[1]
                    Name  = $Matches[2]
                    Gray  = [int]$Matches[3]
                    Total = [int]$Matches[4]
                }
            }
        }

        if ($systems.Count -eq 0) {
            Write-Host "  Net sistem v config\systems.json" -ForegroundColor Yellow
            Read-Host "  Enter - nazad"
            return
        }

        $i = 1
        $map = @{}
        foreach ($s in $systems) {
            $num = "{0,2}" -f $i
            $stats = "(seryh: $($s.Gray) iz $($s.Total))"
            Write-Host "  $num  $($s.Name)" -NoNewline -ForegroundColor White
            Write-Host "  $stats" -ForegroundColor DarkGray
            $map[[string]$i] = $s
            $i++
        }

        Write-Host ""
        Write-Host "   0  Nazad" -ForegroundColor DarkGray
        Write-Host ""

        $ans = Read-Host "  Vyberi sistemu"
        if ($ans -eq "0" -or -not $ans) { return }
        if (-not $map.ContainsKey($ans)) {
            Write-Host "  Net takogo punkta" -ForegroundColor Red
            Start-Sleep -Seconds 1
            continue
        }

        $sys = $map[$ans]
        Manage-OneSystem -SysId $sys.Id -SysName $sys.Name
    }
}

function Open-LastReport {
    $report = Get-ChildItem "$ProjectDir\reports\report-*.html" -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match '^report-[\d\-]+\.html$' } |
              Sort-Object LastWriteTime -Descending |
              Select-Object -First 1
    if ($report) {
        Write-Host ""
        Write-Host "  Otchet: $($report.Name)" -ForegroundColor Green
        Start-Process $report.FullName
    }
}

function Run-Check {
    param($OnlyId, [switch]$DryRun)
    Write-Host ""
    if ($OnlyId) {
        Write-Host "  Proverka: $OnlyId (bez otpravki email) ..." -ForegroundColor Cyan
        node src/index.js --dry-run --only $OnlyId
    } elseif ($DryRun) {
        Write-Host "  TESTOVAYA proverka VSEKH sistem (bez otpravki email) ..." -ForegroundColor Yellow
        node src/index.js --dry-run
    } else {
        Write-Host "  Polnaya proverka + otpravka email ..." -ForegroundColor Cyan
        node src/index.js
    }
    Open-LastReport
    Write-Host ""
    Write-Host "  Enter - nazad v menyu" -ForegroundColor DarkGray
    Read-Host
}

while ($true) {
    Show-Menu
    $choice = Read-Host "  Vyberi punkt"
    switch ($choice) {
        "1"  { Run-Check }
        "T"  { Run-Check -DryRun }
        "t"  { Run-Check -DryRun }
        "2"  { Run-Check "trassir" }
        "3"  { Run-Check "ipanda-office" }
        "4"  { Run-Check "hiwatch-sklad" }
        "5"  { Run-Check "ipanda-noviy-ceh" }
        "6"  { Run-Check "evroplast-stroyka" }
        "7"  { Run-Check "hiwatch-vyduv" }
        "8"  { Run-Check "beward" }
        "9"  { Run-Check "ivms" }
        "10" { Run-Check "rostelecom" }
        "R"  { Open-LastReport; Write-Host ""; Read-Host "  Enter..." }
        "r"  { Open-LastReport; Write-Host ""; Read-Host "  Enter..." }
        "L"  { Start-Process "$ProjectDir\logs" }
        "l"  { Start-Process "$ProjectDir\logs" }
        "S"  { Setup-Schedule }
        "s"  { Setup-Schedule }
        "E"  { Setup-Email }
        "e"  { Setup-Email }
        "G"  { Manage-GrayCameras }
        "g"  { Manage-GrayCameras }
        "0"  { exit }
    }
}
