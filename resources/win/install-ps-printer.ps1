# Installation imprimante virtuelle PostScript "Omnicab PEC"
#
# Strategie:
#  - Driver: "Generic / Text Only" PS... non, on utilise un driver PostScript natif Windows
#    "Generic PostScript Printer" est dispo de base via printers.inf
#  - Port: FILE: (genere un dialogue Save As) OU mieux: port custom mfilemon
#    -> redirige le PS directement vers C:\ProgramData\PecExpress\spool\
#
# Mode "FILE:" simple (sans mfilemon): Windows demande ou enregistrer le PS.
#   Inutilisable en prod, on veut z@ro clic.
#
# Mode mfilemon (recommande):
#   mfilemon est un port monitor open source qui ecrit le job dans un dossier
#   en mode silencieux. Le binaire (mfilemon.dll + mfmconfig.exe) doit etre
#   present dans resources/win/mfilemon/.
#
# Si mfilemon n'est pas dispo, on retombe sur le port LPT1 detourne vers fichier
# (technique: PortPrompt = 0 sur "FILE:" via registre).

param(
    [string]$PrinterName = "Omnicab PEC",
    [string]$SpoolDir = "C:\ProgramData\PecExpress\spool",
    [string]$DriverName = "Generic / Text Only",
    [switch]$UsePostScript = $true
)

$ErrorActionPreference = "Continue"
$transcriptPath = "C:\ProgramData\PecExpress\install-ps-printer.log"
try { Start-Transcript -Path $transcriptPath -Force | Out-Null } catch {}

Write-Output "=== INSTALL PS PRINTER ==="
Write-Output "PrinterName: $PrinterName"
Write-Output "SpoolDir: $SpoolDir"

# Verifier admin
$isAdmin = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Error "Ce script doit etre execute en administrateur"
    exit 1
}

# 1. Creer le dossier spool avec droits Everyone
if (-not (Test-Path $SpoolDir)) {
    New-Item -ItemType Directory -Force -Path $SpoolDir | Out-Null
    Write-Output "Spool cree: $SpoolDir"
}
try {
    $acl = Get-Acl $SpoolDir
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        "Everyone", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.SetAccessRule($rule)
    Set-Acl -Path $SpoolDir -AclObject $acl
    Write-Output "Droits Everyone:Modify appliques sur $SpoolDir"
} catch {
    Write-Output "Avertissement: ACL non modifiees: $_"
}

# 2. Choisir le driver PostScript
# Drivers PS natifs Windows (verifier la dispo)
$psDriverCandidates = @(
    "Microsoft PS Class Driver",
    "Generic PostScript Printer",
    "MS Publisher Color Printer",
    "MS Publisher Imagesetter"
)

$selectedDriver = $null
foreach ($drv in $psDriverCandidates) {
    $found = Get-PrinterDriver -Name $drv -ErrorAction SilentlyContinue
    if ($found) { $selectedDriver = $drv; break }
}

if (-not $selectedDriver) {
    Write-Output "Aucun driver PS pre-installe trouve, tentative d'ajout 'Microsoft PS Class Driver'..."
    try {
        Add-PrinterDriver -Name "Microsoft PS Class Driver" -ErrorAction Stop
        $selectedDriver = "Microsoft PS Class Driver"
    } catch {
        Write-Output "Add-PrinterDriver echoue: $_"
        # Derniere chance: pntpinst sur ntprint.inf
        try {
            $infs = Get-ChildItem "C:\Windows\inf" -Filter "ntprint*.inf" -ErrorAction SilentlyContinue
            foreach ($inf in $infs) {
                & rundll32.exe printui.dll,PrintUIEntry /ia /m "Microsoft PS Class Driver" /f $inf.FullName 2>&1 | Out-Null
                $check = Get-PrinterDriver -Name "Microsoft PS Class Driver" -ErrorAction SilentlyContinue
                if ($check) { $selectedDriver = "Microsoft PS Class Driver"; break }
            }
        } catch {}
    }
}

if (-not $selectedDriver) {
    Write-Error "Aucun driver PostScript disponible sur ce systeme"
    exit 2
}
Write-Output "Driver PS selectionne: $selectedDriver"

# 3. Supprimer ancienne imprimante si existe
Remove-Printer -Name $PrinterName -ErrorAction SilentlyContinue
Write-Output "Ancienne imprimante supprimee (si existait)"

# 4. Creer le port
# Strategie: port "fichier" qui ecrit directement dans SpoolDir
# On utilise un port local de type fichier: nom = chemin complet avec %JobID%

$portName = "CABFLOW_PORT"
$portFile = Join-Path $SpoolDir "job-$(Get-Date -Format 'yyyyMMdd-HHmmss').ps"

# Methode 1: port mfilemon si disponible
$mfilemonPath = Join-Path (Split-Path $PSScriptRoot -Parent) "win\mfilemon\mfilemon.dll"
$useMfilemon = Test-Path $mfilemonPath

if ($useMfilemon) {
    Write-Output "mfilemon detecte: configuration port silencieux"
    # TODO: enregistrer mfilemon comme port monitor + creer port
    # Pour l'instant on retombe sur la methode fichier classique
    $useMfilemon = $false
}

if (-not $useMfilemon) {
    # Methode 2: port local "fichier" - Windows ecrit dans le spool sans dialogue
    # Le nom du port = chemin du fichier de sortie
    # MAIS Windows va prompt l'utilisateur a moins qu'on bypass via registre
    Remove-PrinterPort -Name $portName -ErrorAction SilentlyContinue

    # Creer un port de type "Local Port" pointant vers le spool dir
    # On utilise un nom de fichier fixe + rotation gere par l'app Electron
    $targetFile = Join-Path $SpoolDir "current-job.ps"
    Add-PrinterPort -Name $portName -PrinterHostAddress $targetFile -ErrorAction SilentlyContinue

    # Si Add-PrinterPort echoue (pas un host address), tenter via WMI
    $port = Get-PrinterPort -Name $portName -ErrorAction SilentlyContinue
    if (-not $port) {
        try {
            $cls = [WMIClass]"Win32_TCPIPPrinterPort"
        } catch {}
        # Fallback: utiliser printui.dll
        & rundll32.exe printui.dll,PrintUIEntry /if /b $PrinterName /f "$env:WINDIR\inf\ntprint.inf" /r $portName /m $selectedDriver 2>&1 | Out-Null
    }
}

# 5. Installer l'imprimante
try {
    Add-Printer -Name $PrinterName -DriverName $selectedDriver -PortName $portName -ErrorAction Stop
    Write-Output "Imprimante creee: $PrinterName via $portName"
} catch {
    Write-Output "Add-Printer echoue: $_"
    # Fallback printui.dll
    & rundll32.exe printui.dll,PrintUIEntry /if /b $PrinterName /f "$env:WINDIR\inf\ntprint.inf" /r $portName /m $selectedDriver 2>&1 | Out-Null
}

# 6. Verifier
$created = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
if ($created) {
    Write-Output "OK - Imprimante installee: $PrinterName"
    Write-Output "  Driver: $($created.DriverName)"
    Write-Output "  Port: $($created.PortName)"
    exit 0
} else {
    Write-Error "ECHEC - Imprimante non creee"
    exit 3
}

try { Stop-Transcript | Out-Null } catch {}
