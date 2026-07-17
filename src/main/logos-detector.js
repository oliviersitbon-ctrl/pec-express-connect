/**
 * Logos page Devis detector
 *
 * Detecte si Logos est ouvert sur la page "Devis" d'un patient via inspection
 * des fenetres Win32 (EnumWindows + EnumChildWindows) sans toucher a Logos.
 *
 * Structure UI Logos (reverse engineering valide):
 *  - Process LOGOS_w.exe (32-bit WinDev)
 *  - Pour chaque patient ouvert, 2 fenetres top-level WinDevObject:
 *      - A: titre "<ID> - <NOM Prenom>" 1920x947 pos(0,78)  = fenetre patient
 *      - B: titre vide 1914x871 pos(3,151) = fenetre devis (visible seulement
 *           quand l'utilisateur est sur l'ecran Devis)
 *  - Fenetre B contient les 5 boutons specifiques:
 *      &Imprimer, Devis isole, Eclater le devis, Devis types..., Assistant devis
 *
 * Detection: dans l'ordre Z des fenetres Logos, la 1ere B (sans titre, avec
 * boutons devis) = devis active. La 1ere A juste apres = ID + patient.
 */

const { spawn } = require('child_process');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[LOGOS-DET] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

// PowerShell inline qui:
// 1. Trouve toutes les fenetres top-level Logos visibles (ordre Z = top devant)
// 2. Identifie la 1ere fenetre B "devis active" (sans titre, 1914x871,
//    contient les marqueurs)
// 3. Identifie sa fenetre A patient associee (1ere fenetre suivante avec titre matchant)
// 4. Sort un JSON: { active: bool, devisId, patient, devisHwnd, patientHwnd }
const PS_DETECTOR = String.raw`
Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class LD {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Output '{"active":false,"reason":"logos-not-running"}'
    exit 0
}
$logosPid = $proc.Id

# Verifier que Logos est au PREMIER PLAN
$fg = [LD]::GetForegroundWindow()
$fgPid = 0
[LD]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
$fgIsLogos = ($fgPid -eq $logosPid)
if (-not $fgIsLogos) {
    Write-Output '{"active":false,"reason":"logos-not-foreground","logosForeground":false}'
    exit 0
}
# Marqueur: Logos EST foreground, peu importe la page
$logosForeground = $true

# 1. Enumerer fenetres top-level Logos VISIBLES (ordre Z naturel)
$wins = New-Object System.Collections.ArrayList
$cb = [LD+EnumProc]{ param($h, $l)
    if ([LD]::IsWindowVisible($h) -and -not [LD]::IsIconic($h)) {
        $pp = 0; [LD]::GetWindowThreadProcessId($h, [ref]$pp) | Out-Null
        if ($pp -eq $logosPid) {
            $sb = New-Object System.Text.StringBuilder(512)
            [LD]::GetWindowText($h, $sb, 512) | Out-Null
            $rect = New-Object LD+RECT
            [LD]::GetWindowRect($h, [ref]$rect) | Out-Null
            $w = $rect.Right - $rect.Left
            $hh = $rect.Bottom - $rect.Top
            # Filtrer les fenetres hors-ecran ou trop petites
            if ($rect.Left -gt -4000 -and $w -gt 100 -and $hh -gt 100) {
                [void]$script:wins.Add([PSCustomObject]@{
                    HWnd = $h.ToInt64()
                    Title = $sb.ToString()
                    W = $w; H = $hh
                    Left = $rect.Left; Top = $rect.Top
                })
            }
        }
    }
    return $true
}
[LD]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

# 2. Identifier la 1ere fenetre B "devis active"
#    Critere: title vide + contient >=3 marqueurs devis (Imprimer, Eclater le
#    devis, etc.). INDEPENDANT DE LA RESOLUTION : on ne filtre plus sur une
#    taille codee en dur (1914x871) — un seuil minimal suffit, ce sont les
#    marqueurs (boutons reels de l'ecran devis) qui font foi. Ainsi la detection
#    fonctionne sur tout ecran / toute mise a l'echelle Windows.
$markersRegex = "Imprimer|Devis isol.|Eclater le devis|Devis types|Assistant devis"
$devisB = $null
foreach ($w in $wins) {
    if ($w.Title.Length -gt 0) { continue }
    if ($w.W -lt 900 -or $w.H -lt 500) { continue }  # simple garde anti mini-fenetre
    $markersFound = @()
    $cbB = [LD+EnumProc]{ param($h, $l)
        if ([LD]::IsWindowVisible($h)) {
            $cls = New-Object System.Text.StringBuilder(64)
            [LD]::GetClassName($h, $cls, 64) | Out-Null
            if ($cls.ToString() -match "Button") {
                $sb = New-Object System.Text.StringBuilder(128)
                [LD]::GetWindowText($h, $sb, 128) | Out-Null
                $t = $sb.ToString()
                if ($t -match $markersRegex) {
                    $script:markersFound += $t.Trim()
                }
            }
        }
        return $true
    }
    [LD]::EnumChildWindows([IntPtr]$w.HWnd, $cbB, [IntPtr]::Zero) | Out-Null
    $uniqMarkers = ($markersFound | Sort-Object -Unique).Count
    if ($uniqMarkers -ge 3) {
        $devisB = $w
        $devisB | Add-Member -NotePropertyName 'MarkersFound' -NotePropertyValue $uniqMarkers
        break
    }
}

# Trouver la fenetre principale Logos (main window, contient "LOGOS_w - v") pour
# avoir les coords meme si pas de page devis active
$mainLogos = $null
foreach ($w in $wins) {
    if ($w.Title -match 'LOGOS_w') { $mainLogos = $w; break }
}

if (-not $devisB) {
    # Logos foreground mais pas de page devis -> on remonte les coords main
    $out = @{
        active = $false
        reason = "no-devis-window"
        logosForeground = $true
        logosLeft = if ($mainLogos) { $mainLogos.Left } else { 0 }
        logosTop = if ($mainLogos) { $mainLogos.Top } else { 0 }
        logosWidth = if ($mainLogos) { $mainLogos.W } else { 1920 }
        logosHeight = if ($mainLogos) { $mainLogos.H } else { 1080 }
    } | ConvertTo-Json -Compress
    Write-Output $out
    exit 0
}

# 3. Trouver la fenetre patient A associee = 1ere fenetre apres B dans ordre Z avec
#    titre matchant '<ID> - <NOM>'
$devisBIdx = $wins.IndexOf($devisB)
$patientA = $null
for ($i = $devisBIdx + 1; $i -lt $wins.Count; $i++) {
    $w = $wins[$i]
    if ($w.Title -match '^(\d+)\s*-\s*(.+)$') {
        $patientA = $w
        $patientA | Add-Member -NotePropertyName 'DevisId' -NotePropertyValue $matches[1]
        $patientA | Add-Member -NotePropertyName 'PatientName' -NotePropertyValue $matches[2].Trim()
        break
    }
}

# Si pas trouve apres B, chercher AVANT (parfois A est avant B dans Z)
if (-not $patientA) {
    for ($i = 0; $i -lt $devisBIdx; $i++) {
        $w = $wins[$i]
        if ($w.Title -match '^(\d+)\s*-\s*(.+)$') {
            $patientA = $w
            $patientA | Add-Member -NotePropertyName 'DevisId' -NotePropertyValue $matches[1]
            $patientA | Add-Member -NotePropertyName 'PatientName' -NotePropertyValue $matches[2].Trim()
            break
        }
    }
}

if (-not $patientA) {
    Write-Output ('{"active":true,"reason":"no-patient-window","devisHwnd":' + $devisB.HWnd + ',"markers":' + $devisB.MarkersFound + '}')
    exit 0
}

# Precision : la fenetre devis (B) est-elle celle qui a le FOCUS ?
# Sur l'ecran Devis, la fenetre active est B (l'editeur de devis). Sur l'ecran
# schema/actes/fiche, le contenu est affiche par la fenetre patient (A) -> B
# n'est PAS au premier plan (elle peut meme rester ouverte en arriere-plan).
# On exige donc fg == B (et non A) pour n'afficher l'overlay QUE lorsqu'on edite
# reellement le devis. GetForegroundWindow renvoie le top-level -> compare a B.
$fgId = $fg.ToInt64()
$devisFocused = ($fgId -eq $devisB.HWnd)

# Localiser DANS la fenetre devis (coords ECRAN, une seule passe) :
#  - le bouton "Imprimer" (reference historique)
#  - le bouton "Eclater le devis" = rangee "Ajouter/Creer alternative/Eclater/
#    Voir les a faire". C'est SOUS la ligne de cette rangee que l'overlay doit
#    se placer. On prend son bas comme ancre -> robuste a la resolution.
# Le TRAIT sous lequel poser l'overlay = bord inferieur de la barre d'outils
# "Ajouter alternative / Creer alternative / Eclater le devis / Voir les a faire".
# On prend le BAS LE PLUS BAS de ces boutons (toute la rangee) -> repere fiable
# du trait, robuste a la resolution/echelle et a un bouton masque/renomme.
# NB: on cible ces libelles precis pour NE PAS attraper le menu "Alternatives."
# de la zone des actes, situe bien plus bas.
$printer = $null
$rowBottomMax = $null
$rowRegex = "Ajouter alternative|Eclater le devis|Voir les"
$cbP = [LD+EnumProc]{ param($h, $l)
    if ([LD]::IsWindowVisible($h)) {
        $cls = New-Object System.Text.StringBuilder(64)
        [LD]::GetClassName($h, $cls, 64) | Out-Null
        if ($cls.ToString() -match "Button") {
            $sb = New-Object System.Text.StringBuilder(128)
            [LD]::GetWindowText($h, $sb, 128) | Out-Null
            $t = $sb.ToString()
            if (-not $script:printer -and $t -match "Imprimer") {
                $pr = New-Object LD+RECT
                [LD]::GetWindowRect($h, [ref]$pr) | Out-Null
                $script:printer = [PSCustomObject]@{ L = $pr.Left; T = $pr.Top; R = $pr.Right; B = $pr.Bottom }
            }
            if ($t -match $rowRegex) {
                $rr = New-Object LD+RECT
                [LD]::GetWindowRect($h, [ref]$rr) | Out-Null
                if (($null -eq $script:rowBottomMax) -or ($rr.Bottom -gt $script:rowBottomMax)) {
                    $script:rowBottomMax = $rr.Bottom
                }
            }
        }
    }
    return $true
}
[LD]::EnumChildWindows([IntPtr]$devisB.HWnd, $cbP, [IntPtr]::Zero) | Out-Null

# Recuperer aussi la position de la fenetre patient A (= fenetre Logos visible)
# pour pouvoir positionner le bouton overlay relatif a Logos
$result = @{
    active = $true
    devisHwnd = $devisB.HWnd
    patientHwnd = $patientA.HWnd
    devisId = $patientA.DevisId
    patient = $patientA.PatientName
    markers = $devisB.MarkersFound
    foregroundHwnd = $fgId
    devisFocused = $devisFocused
    printerLeft = if ($printer) { $printer.L } else { $null }
    printerTop = if ($printer) { $printer.T } else { $null }
    printerRight = if ($printer) { $printer.R } else { $null }
    printerBottom = if ($printer) { $printer.B } else { $null }
    rowLeft = if ($rowBtn) { $rowBtn.L } else { $null }
    rowTop = if ($rowBtn) { $rowBtn.T } else { $null }
    rowRight = if ($rowBtn) { $rowBtn.R } else { $null }
    rowBottom = if ($rowBtn) { $rowBtn.B } else { $null }
    logosLeft = $patientA.Left
    logosTop = $patientA.Top
    logosWidth = $patientA.W
    logosHeight = $patientA.H
} | ConvertTo-Json -Compress
Write-Output $result
`;

let _detectorBusy = false;

/**
 * Detecte si Logos est sur la page Devis et retourne les infos du devis affiche.
 *
 * @returns {Promise<{active: boolean, devisId?: string, patient?: string,
 *                    devisHwnd?: number, patientHwnd?: number, markers?: number,
 *                    reason?: string}>}
 */
async function detectDevisPage() {
  if (_detectorBusy) return { active: false, reason: 'busy' };
  _detectorBusy = true;
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-Command', PS_DETECTOR
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });

    const timeout = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      _detectorBusy = false;
      resolve({ active: false, reason: 'timeout' });
    }, 3000);

    proc.on('close', () => {
      clearTimeout(timeout);
      _detectorBusy = false;
      try {
        const lines = stdout.trim().split('\n').filter(l => l.trim().startsWith('{'));
        if (lines.length === 0) {
          resolve({ active: false, reason: 'no-output', stderr: stderr.slice(0, 200) });
          return;
        }
        const data = JSON.parse(lines[lines.length - 1]);
        resolve(data);
      } catch (e) {
        resolve({ active: false, reason: 'parse-error', error: e.message });
      }
    });
    proc.on('error', e => {
      clearTimeout(timeout);
      _detectorBusy = false;
      resolve({ active: false, reason: 'spawn-error', error: e.message });
    });
  });
}

module.exports = { setLogger, detectDevisPage };
