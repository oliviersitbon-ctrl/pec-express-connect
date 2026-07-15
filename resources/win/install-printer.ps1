# Installation 100% silencieuse de l'imprimante PECExpress_PEC
# Pas de popup, pas d'assistant, pas de mfilemon-setup.exe
# Copie directement mfilemon.dll dans System32, ecrit la cle registry,
# redemarre le spooler, cree le port + imprimante.

param(
    [string]$SpoolDir = "C:\ProgramData\PecExpress\spool"
)

$ErrorActionPreference = "Continue"
$logFile = "C:\ProgramData\PecExpress\install-printer.log"

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

Log "=== Installation imprimante PECExpress_PEC (silencieuse) ==="

if (-not (Test-Path $SpoolDir)) {
    New-Item -ItemType Directory -Path $SpoolDir -Force | Out-Null
    Log "Dossier spool cree: $SpoolDir"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$PrinterName = "PECExpress_PEC"
$PortName = "MFILEMON:$PrinterName"
$DriverName = "Microsoft Print To PDF"
$MonitorName = "Multi File Port Monitor"

# 1. Installation manuelle du port monitor mfilemon (PAS de mfilemon-setup.exe = popup)
$mfilemonDllSrc = Join-Path $ScriptDir "mfilemon64.dll"
$mfilemonDllDest = "$env:SystemRoot\System32\mfilemon.dll"
$monitorKey = "HKLM:\SYSTEM\CurrentControlSet\Control\Print\Monitors\$MonitorName"

if (-not (Test-Path $mfilemonDllSrc)) {
    Log "ERREUR: mfilemon64.dll absente du package: $mfilemonDllSrc"
    exit 1
}

# Copie la DLL si pas deja en place
$needRestart = $false
if (-not (Test-Path $mfilemonDllDest)) {
    Log "Copie mfilemon.dll vers System32..."
    Copy-Item $mfilemonDllSrc $mfilemonDllDest -Force
    $needRestart = $true
} else {
    Log "mfilemon.dll deja presente dans System32"
}

# Ecrit la cle registry du monitor
if (-not (Test-Path $monitorKey)) {
    Log "Creation cle registry monitor..."
    New-Item -Path $monitorKey -Force | Out-Null
    New-ItemProperty -Path $monitorKey -Name "Driver" -Value "mfilemon.dll" -PropertyType String -Force | Out-Null
    $needRestart = $true
}

# Redemarre le spooler si necessaire (pour charger le monitor)
if ($needRestart) {
    Log "Redemarrage du spooler..."
    Restart-Service Spooler -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 3
}

# 2. Configuration mfilemon.ini
$mfilemonIni = "$env:SystemRoot\mfilemon.ini"
$portConfig = @"
[$PortName]
OutputPath=$SpoolDir
FilePattern=%Y%m%d_%H%M%S_%c.pdf
Overwrite=no
UserCommand=
ExecPath=
WaitTermination=no
PipeData=no
"@

if (Test-Path $mfilemonIni) {
    $existing = Get-Content $mfilemonIni -Raw -ErrorAction SilentlyContinue
    if ($existing -notmatch [regex]::Escape("[$PortName]")) {
        Add-Content -Path $mfilemonIni -Value "`n$portConfig"
        Log "Config $PortName ajoutee a mfilemon.ini"
    }
} else {
    Set-Content -Path $mfilemonIni -Value $portConfig
    Log "mfilemon.ini cree"
}

# 3. Supprime ancienne imprimante/port (idempotent)
Remove-Printer -Name $PrinterName -ErrorAction SilentlyContinue
Remove-PrinterPort -Name $PortName -ErrorAction SilentlyContinue

# 4. Cree port + imprimante
try {
    Add-PrinterPort -Name $PortName -ErrorAction Stop
    Log "Port $PortName cree"
} catch {
    Log "Erreur Add-PrinterPort: $($_.Exception.Message)"
}

try {
    Add-Printer -Name $PrinterName -DriverName $DriverName -PortName $PortName `
                -Comment "PecExpress PEC - Mon devis dentaire Connecté" -ErrorAction Stop
    Log "Imprimante $PrinterName creee"
} catch {
    Log "Erreur Add-Printer: $($_.Exception.Message)"
}

# 5. Verif finale
$p = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($p) {
    Log "=== OK Imprimante $PrinterName operationnelle (port=$($p.PortName)) ==="
    exit 0
} else {
    Log "=== ECHEC ==="
    exit 1
}
