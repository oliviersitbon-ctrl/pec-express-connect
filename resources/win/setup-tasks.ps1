# Cree les taches planifiees Windows pour Mon devis dentaire Connecté
# Appele par l'installeur NSIS en mode admin
# 1. PecExpressInjector : injecte DLL dans Logos toutes les minutes (SYSTEM)
# 2. PecExpressWatchdog : relance l'app si crash (SYSTEM)

param(
    [string]$InstallDir = "C:\Program Files\Mon devis dentaire Connecté"
)

$ErrorActionPreference = "Continue"
$logFile = "C:\ProgramData\PecExpress\setup-tasks.log"

function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    Write-Host $line
    try {
        if (-not (Test-Path "C:\ProgramData\PecExpress")) {
            New-Item -ItemType Directory -Path "C:\ProgramData\PecExpress" -Force | Out-Null
        }
        Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    } catch {}
}

Log "=== Setup taches planifiees ==="
Log "InstallDir: $InstallDir"

# Supprime anciennes taches si presentes
schtasks /Delete /F /TN "PecExpressInjector" 2>$null | Out-Null
schtasks /Delete /F /TN "PecExpressWatchdog" 2>$null | Out-Null

# Cree le watchdog.ps1 dans ProgramData
$watchdogPath = "C:\ProgramData\PecExpress\watchdog.ps1"
$watchdogContent = @"
`$exePath = "$InstallDir\Mon devis dentaire Connecté.exe"
`$manualQuit = "`$env:LOCALAPPDATA\LogosConnect\.manual-quit"
if (Test-Path `$manualQuit) { exit 0 }
`$p = Get-Process "Mon devis dentaire Connecté" -ErrorAction SilentlyContinue
if (-not `$p) { Start-Process `$exePath -ArgumentList "--hidden" -WindowStyle Hidden }
"@
Set-Content -Path $watchdogPath -Value $watchdogContent -Force
Log "watchdog.ps1 cree"

# Path du script injector
$injectorScript = Join-Path $InstallDir "resources\resources\win\injector-task.ps1"
if (-not (Test-Path $injectorScript)) {
    Log "ERREUR: injector-task.ps1 introuvable: $injectorScript"
}

# ===== Creation tache Injector (avec Register-ScheduledTask = plus fiable que schtasks) =====
try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$injectorScript`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName "PecExpressInjector" `
        -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
        -Description "Injecte la DLL PecExpress dans LOGOS_w.exe" -Force | Out-Null
    Log "Tache PecExpressInjector creee OK"
} catch {
    Log "ERREUR creation Injector: $($_.Exception.Message)"
    # Fallback: schtasks via array d'args (evite les problemes de quote)
    $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$injectorScript`""
    & schtasks /Create /F /TN PecExpressInjector /SC MINUTE /MO 1 /RU SYSTEM /RL HIGHEST /TR "powershell.exe $argLine" 2>&1 | ForEach-Object { Log "schtasks: $_" }
}

# ===== Creation tache Watchdog =====
try {
    $action2 = New-ScheduledTaskAction -Execute "powershell.exe" `
        -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$watchdogPath`""
    $trigger2 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $principal2 = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName "PecExpressWatchdog" `
        -Action $action2 -Trigger $trigger2 -Principal $principal2 -Settings $settings2 `
        -Description "Relance Mon devis dentaire Connecté si arret inattendu" -Force | Out-Null
    Log "Tache PecExpressWatchdog creee OK"
} catch {
    Log "ERREUR creation Watchdog: $($_.Exception.Message)"
}

# Force run immediat de l'injecteur (si Logos deja lance, injecte tout de suite)
Start-ScheduledTask -TaskName "PecExpressInjector" -ErrorAction SilentlyContinue
Log "Injector lance immediatement"

# Verification finale
$tInj = Get-ScheduledTask -TaskName "PecExpressInjector" -ErrorAction SilentlyContinue
$tWd = Get-ScheduledTask -TaskName "PecExpressWatchdog" -ErrorAction SilentlyContinue
Log "Etat final: Injector=$($tInj -ne $null), Watchdog=$($tWd -ne $null)"
exit 0
