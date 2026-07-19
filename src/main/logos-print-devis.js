'use strict';

/**
 * logos-print-devis.js
 *
 * Declenche l'impression + enregistrement du PDF officiel du devis Logos, en
 * simulant un Shift+clic REEL sur le bouton "Imprimer" de la fenetre devis
 * (comportement decrit par l'utilisateur : Shift+clic imprimante = imprime ET
 * enregistre le PDF dans LIENS\<numero>). Puis attend l'apparition d'un
 * Devis-*.pdf frais dans ce dossier.
 *
 * Best-effort : si le bouton n'est pas trouve ou si aucun PDF n'apparait dans le
 * delai, on n'echoue PAS (l'envoi se poursuit, avec le dernier PDF dispo s'il y
 * en a un). Objectif : "un clic Envoi de devis declenche toute la chaine".
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { psLoadNative } = require('./native-dll');

let log = () => {};
function setLogger(fn) { if (typeof fn === 'function') log = fn; }

// PowerShell : trouve la fenetre devis de Logos (au premier plan), y localise le
// bouton dont le texte contient "Imprimer", et fait un Shift+clic reel en son
// centre (SHIFT enfonce via keybd_event, clic via mouse_event), puis restaure la
// position du curseur. Sort un JSON { ok, x?, y?, reason? }.
const PS_SHIFT_CLICK_IMPRIMER = String.raw`${psLoadNative('PD')}
if (-not ('PD' -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PD {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@ -ErrorAction SilentlyContinue
}

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output '{"ok":false,"reason":"logos-not-running"}'; exit 0 }
$logosPid = $proc.Id

$fg = [PD]::GetForegroundWindow(); $fgPid = 0
[PD]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
if ($fgPid -ne $logosPid) { Write-Output '{"ok":false,"reason":"logos-not-foreground"}'; exit 0 }

# Fenetres top-level Logos visibles
$wins = New-Object System.Collections.ArrayList
$cb = [PD+EnumProc]{ param($h,$l)
  if ([PD]::IsWindowVisible($h) -and -not [PD]::IsIconic($h)) {
    $pp=0; [PD]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $logosPid) {
      $sb=New-Object System.Text.StringBuilder(512); [PD]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object PD+RECT; [PD]::GetWindowRect($h,[ref]$r) | Out-Null
      $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
      if ($r.Left -gt -4000 -and $w -gt 100 -and $hh -gt 100) {
        [void]$script:wins.Add([PSCustomObject]@{ HWnd=$h; Title=$sb.ToString(); W=$w; H=$hh })
      }
    }
  }
  return $true
}
[PD]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null

# Fenetre devis B : titre vide, ~1914x871, contient les boutons devis
$markersRegex = "Imprimer|Devis isol.|Eclater le devis|Devis types|Assistant devis"
$devisB = $null
foreach ($w in $wins) {
  if ($w.Title.Length -gt 0) { continue }
  if ($w.W -lt 1800 -or $w.W -gt 1950) { continue }
  if ($w.H -lt 800 -or $w.H -gt 900) { continue }
  $cnt = 0
  $cbM = [PD+EnumProc]{ param($h,$l)
    $cls=New-Object System.Text.StringBuilder(64); [PD]::GetClassName($h,$cls,64) | Out-Null
    if ($cls.ToString() -match "Button") {
      $sb=New-Object System.Text.StringBuilder(128); [PD]::GetWindowText($h,$sb,128) | Out-Null
      if ($sb.ToString() -match $markersRegex) { $script:cnt++ }
    }
    return $true
  }
  [PD]::EnumChildWindows($w.HWnd,$cbM,[IntPtr]::Zero) | Out-Null
  if ($cnt -ge 3) { $devisB = $w; break }
}
if (-not $devisB) { Write-Output '{"ok":false,"reason":"no-devis-window"}'; exit 0 }

# Bouton "Imprimer" dans la fenetre devis
$btn = $null
$cbB = [PD+EnumProc]{ param($h,$l)
  if ([PD]::IsWindowVisible($h)) {
    $cls=New-Object System.Text.StringBuilder(64); [PD]::GetClassName($h,$cls,64) | Out-Null
    if ($cls.ToString() -match "Button") {
      $sb=New-Object System.Text.StringBuilder(128); [PD]::GetWindowText($h,$sb,128) | Out-Null
      $t=$sb.ToString()
      if ($t -match "Imprimer" -and -not $script:btn) {
        $r=New-Object PD+RECT; [PD]::GetWindowRect($h,[ref]$r) | Out-Null
        $script:btn=[PSCustomObject]@{ HWnd=$h; W=($r.Right-$r.Left); H=($r.Bottom-$r.Top); CX=[int](($r.Left+$r.Right)/2); CY=[int](($r.Top+$r.Bottom)/2); T=$t }
      }
    }
  }
  return $true
}
[PD]::EnumChildWindows($devisB.HWnd,$cbB,[IntPtr]::Zero) | Out-Null
if (-not $btn) { Write-Output '{"ok":false,"reason":"no-imprimer-button"}'; exit 0 }

# CLIC INVISIBLE : on envoie le message clic DIRECTEMENT au bouton (par son
# handle), sans bouger la vraie souris ni changer le premier plan. Le Shift est
# maintenu au niveau clavier (les controles WinDev lisent l'etat de Shift a la
# volee) le temps d'envoyer le down/up.
$clx = [int]($btn.W/2); if ($clx -lt 1) { $clx = 3 }
$cly = [int]($btn.H/2); if ($cly -lt 1) { $cly = 3 }
$lp = [IntPtr](($cly -shl 16) -bor $clx)   # lParam = coords client (y<<16 | x)
[PD]::keybd_event(0x10,0,0,[IntPtr]::Zero)                    # SHIFT down (etat clavier, pas de mouvement souris)
Start-Sleep -Milliseconds 40
[PD]::PostMessage($btn.HWnd,0x0200,[IntPtr]4,$lp) | Out-Null   # WM_MOUSEMOVE (MK_SHIFT) : "arme" le survol
[PD]::PostMessage($btn.HWnd,0x0201,[IntPtr]5,$lp) | Out-Null   # WM_LBUTTONDOWN (MK_LBUTTON|MK_SHIFT)
Start-Sleep -Milliseconds 70
[PD]::PostMessage($btn.HWnd,0x0202,[IntPtr]4,$lp) | Out-Null   # WM_LBUTTONUP (MK_SHIFT)
Start-Sleep -Milliseconds 40
[PD]::keybd_event(0x10,0,2,[IntPtr]::Zero)                    # SHIFT up
Write-Output ('{"ok":true,"hwnd":' + $btn.HWnd.ToInt64() + ',"invisible":true}')
`;

function shiftClickImprimer() {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-Command', PS_SHIFT_CLICK_IMPRIMER,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '', err = '';
    proc.stdout.on('data', d => out += d.toString('utf8'));
    proc.stderr.on('data', d => err += d.toString('utf8'));
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ ok: false, reason: 'timeout' }); }, 6000);
    proc.on('close', () => {
      clearTimeout(to);
      try {
        const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
        resolve(line ? JSON.parse(line) : { ok: false, reason: 'no-output', err: err.slice(0, 150) });
      } catch (e) { resolve({ ok: false, reason: 'parse-error' }); }
    });
    proc.on('error', e => { clearTimeout(to); resolve({ ok: false, reason: 'spawn-error', err: e.message }); });
  });
}

function snapshotPdfs(dir) {
  const map = new Map();
  let entries = [];
  try { entries = fs.readdirSync(dir); } catch (e) { return map; }
  for (const f of entries) {
    if (!/^Devis-.*\.pdf$/i.test(f)) continue;
    try { const st = fs.statSync(path.join(dir, f)); if (st.isFile()) map.set(f, st.mtimeMs); } catch (e) {}
  }
  return map;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Attend qu'un fichier soit COMPLETEMENT ecrit (taille non nulle et stable sur
 * deux lectures espacees). Evite d'envoyer un PDF encore en cours d'ecriture par
 * Logos. @returns {Promise<boolean>}
 */
async function isStable(file) {
  try {
    const s1 = fs.statSync(file).size;
    if (!s1) return false;
    await sleep(700);
    const s2 = fs.statSync(file).size;
    return s2 > 0 && s1 === s2;
  } catch (e) { return false; }
}

/**
 * Imprime/enregistre le devis courant (Shift+clic Imprimer) puis attend qu'un
 * Devis-*.pdf frais apparaisse dans LIENS\<numero> ET soit entierement ecrit.
 * @returns {Promise<boolean>} true si un PDF frais et stable est apparu.
 */
async function printAndWaitPdf(patientsDir, numero, opts = {}) {
  const timeoutMs = opts.timeoutMs || 25000; // Logos peut mettre plusieurs secondes a spooler+ecrire
  if (!patientsDir || numero == null || numero === '') {
    log('[PRINT-DEVIS] Contexte incomplet (patientsDir/numero) - skip impression auto');
    return false;
  }
  const dir = path.join(patientsDir, 'LIENS', String(numero));
  const before = snapshotPdfs(dir);

  const r = await shiftClickImprimer();
  if (!r.ok) {
    log('[PRINT-DEVIS] Shift+clic Imprimer non effectue: ' + (r.reason || '?') + (r.err ? ' (' + r.err + ')' : ''));
    return false;
  }
  log('[PRINT-DEVIS] Shift+clic Imprimer effectue (' + r.x + ',' + r.y + ') - attente du PDF...');

  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    await sleep(600);
    const now = snapshotPdfs(dir);
    for (const [f, m] of now) {
      const prev = before.get(f);
      if (prev == null || m > prev) { // nouveau fichier OU re-enregistre plus recent
        // On attend que le fichier soit ENTIEREMENT ecrit avant de valider.
        if (await isStable(path.join(dir, f))) {
          log('[PRINT-DEVIS] PDF frais detecte et stable: ' + f);
          return true;
        }
        log('[PRINT-DEVIS] PDF ' + f + ' encore en cours d\'ecriture, on patiente...');
      }
    }
  }
  log('[PRINT-DEVIS] Aucun PDF frais/stable apres ' + timeoutMs + 'ms (dialogue Logos ?) - on continue');
  return false;
}

module.exports = { setLogger, printAndWaitPdf, shiftClickImprimer };
