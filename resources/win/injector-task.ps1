# Script lance par la tache planifiee Windows en tant que SYSTEM (admin)
# Toutes les minutes :
#   1. Verifie si Logos tourne
#   2. Si oui, verifie si notre DLL est deja injectee
#   3. Si non injectee, injecte avec cabflow-logos-injector.exe
#
# Tourne en SYSTEM donc a SeDebugPrivilege automatique -> peut injecter sans UAC

$logFile = "C:\ProgramData\PecExpress\injector-task.log"
function Log($msg) {
    $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
    try {
        if (-not (Test-Path "C:\ProgramData\PecExpress")) {
            New-Item -ItemType Directory -Path "C:\ProgramData\PecExpress" -Force | Out-Null
        }
        Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
    } catch {}
}

# Trouve injector + DLL dans le repertoire d'install
$injector = "C:\Program Files\Mon devis dentaire Connecté\resources\native\cabflow-logos-injector.exe"
$dll = "C:\Program Files\Mon devis dentaire Connecté\resources\native\cabflow-logos-bridge.dll"

if (-not (Test-Path $injector)) { exit 0 }
if (-not (Test-Path $dll)) { exit 0 }

# Logos tourne ?
$logos = Get-Process LOGOS_w -ErrorAction SilentlyContinue
if (-not $logos) { exit 0 }

foreach ($p in $logos) {
    $pid_ = $p.Id
    # DLL deja injectee dans ce PID ?
    $injected = $false
    try {
        $injected = $p.Modules | Where-Object { $_.ModuleName -eq "cabflow-logos-bridge.dll" } | Select-Object -First 1
    } catch {}
    if ($injected) { continue }

    # Pas injectee -> injection
    Log "Injection DLL dans Logos PID=$pid_"
    & $injector $pid_ $dll 2>&1 | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Log "  OK injection PID=$pid_"
    } else {
        Log "  ECHEC injection PID=$pid_ exit=$LASTEXITCODE"
    }
}
