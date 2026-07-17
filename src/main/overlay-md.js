'use strict';

/**
 * overlay-md.js
 *
 * Bouton "MD" (favicon Mon devis dentaire) RÉELLEMENT INTÉGRÉ dans Logos :
 * la fenetre Electron du bouton est attachée comme ENFANT (SetParent / WS_CHILD)
 * de la fenetre devis de Logos, positionnée JUSTE SOUS le bouton imprimante.
 * Étant enfant, elle bouge et se clippe avec Logos comme un vrai contrôle natif
 * (pas une pastille flottante). Indépendant des deux boutons flottants
 * (overlay-pec.js) — ce module ne les touche pas.
 *
 * ETAT : scaffold. Le bouton n'est rattaché à AUCUNE action pour le moment.
 *
 * NB : SetParent casse le rendu TRANSPARENT d'Electron → la fenetre est OPAQUE
 * (fond blanc), le favicon la remplit. C'est le compromis pour une vraie
 * intégration enfant.
 */

const { BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { setChildOf, unsetChild, setLogger: setW32Logger } = require('./win32-utils');

let _logger = null;
function setLogger(fn) { _logger = fn; setW32Logger(fn); }
function log(msg) {
  const full = `[OVERLAY-MD] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

let _win = null;
let _childHwnd = null;      // HWND natif de la fenetre bouton (string décimal)
let _attachedParent = null; // HWND parent Logos actuel (string) ou null
let _timer = null;
let _busy = false;
let _suspended = false;

const MD_SIZE = 30;        // bouton carré 30x30
const GAP_BELOW = 4;       // espace sous le bouton imprimante
const POLL_MS = 1500;

// PowerShell : localise le bouton "Imprimer" de la fenetre devis Logos et sort,
// en coordonnees ECRAN, le rectangle du bouton + l'origine CLIENT de la fenetre
// devis (pour convertir en coords relatives au parent lors du SetParent).
// { ok, parent, cox, coy, left, top, right, bottom }
const PS_FIND = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class MDL {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output '{"ok":false,"reason":"logos-not-running"}'; exit 0 }
$logosPid = $proc.Id

$fg = [MDL]::GetForegroundWindow(); $fgPid = 0
[MDL]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
if ($fgPid -ne $logosPid) { Write-Output '{"ok":false,"reason":"logos-not-foreground"}'; exit 0 }

$wins = New-Object System.Collections.ArrayList
$cb = [MDL+EnumProc]{ param($h,$l)
  if ([MDL]::IsWindowVisible($h) -and -not [MDL]::IsIconic($h)) {
    $pp=0; [MDL]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $logosPid) {
      $sb=New-Object System.Text.StringBuilder(512); [MDL]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object MDL+RECT; [MDL]::GetWindowRect($h,[ref]$r) | Out-Null
      $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
      if ($r.Left -gt -4000 -and $w -gt 100 -and $hh -gt 100) {
        [void]$script:wins.Add([PSCustomObject]@{ HWnd=$h; Title=$sb.ToString(); W=$w; H=$hh })
      }
    }
  }
  return $true
}
[MDL]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null

$markersRegex = "Imprimer|Devis isol.|Eclater le devis|Devis types|Assistant devis"
$devisB = $null
foreach ($w in $wins) {
  if ($w.Title.Length -gt 0) { continue }
  if ($w.W -lt 1800 -or $w.W -gt 1950) { continue }
  if ($w.H -lt 800 -or $w.H -gt 900) { continue }
  $cnt = 0
  $cbM = [MDL+EnumProc]{ param($h,$l)
    $cls=New-Object System.Text.StringBuilder(64); [MDL]::GetClassName($h,$cls,64) | Out-Null
    if ($cls.ToString() -match "Button") {
      $sb=New-Object System.Text.StringBuilder(128); [MDL]::GetWindowText($h,$sb,128) | Out-Null
      if ($sb.ToString() -match $markersRegex) { $script:cnt++ }
    }
    return $true
  }
  [MDL]::EnumChildWindows($w.HWnd,$cbM,[IntPtr]::Zero) | Out-Null
  if ($cnt -ge 3) { $devisB = $w; break }
}
if (-not $devisB) { Write-Output '{"ok":false,"reason":"no-devis-window"}'; exit 0 }

$btn = $null
$cbB = [MDL+EnumProc]{ param($h,$l)
  if ([MDL]::IsWindowVisible($h)) {
    $cls=New-Object System.Text.StringBuilder(64); [MDL]::GetClassName($h,$cls,64) | Out-Null
    if ($cls.ToString() -match "Button") {
      $sb=New-Object System.Text.StringBuilder(128); [MDL]::GetWindowText($h,$sb,128) | Out-Null
      if ($sb.ToString() -match "Imprimer" -and -not $script:btn) {
        $r=New-Object MDL+RECT; [MDL]::GetWindowRect($h,[ref]$r) | Out-Null
        $script:btn=[PSCustomObject]@{ L=$r.Left; T=$r.Top; R=$r.Right; B=$r.Bottom }
      }
    }
  }
  return $true
}
[MDL]::EnumChildWindows($devisB.HWnd,$cbB,[IntPtr]::Zero) | Out-Null
if (-not $btn) { Write-Output '{"ok":false,"reason":"no-imprimer-button"}'; exit 0 }

# Origine CLIENT de la fenetre devis en coords ecran (pour convertir en coords parent)
$co = New-Object MDL+POINT; $co.X = 0; $co.Y = 0
[MDL]::ClientToScreen($devisB.HWnd, [ref]$co) | Out-Null

Write-Output ('{"ok":true,"parent":' + $devisB.HWnd.ToInt64() + ',"cox":' + $co.X + ',"coy":' + $co.Y + ',"left":' + $btn.L + ',"top":' + $btn.T + ',"right":' + $btn.R + ',"bottom":' + $btn.B + '}')
`;

function findPrinter() {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-Command', PS_FIND,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => out += d.toString('utf8'));
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ ok: false, reason: 'timeout' }); }, 5000);
    proc.on('close', () => {
      clearTimeout(to);
      try {
        const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
        resolve(line ? JSON.parse(line) : { ok: false, reason: 'no-output' });
      } catch (e) { resolve({ ok: false, reason: 'parse-error' }); }
    });
    proc.on('error', () => { clearTimeout(to); resolve({ ok: false, reason: 'spawn-error' }); });
  });
}

function createWindow() {
  if (_win && !_win.isDestroyed()) return _win;
  _win = new BrowserWindow({
    width: MD_SIZE,
    height: MD_SIZE,
    x: -2000, y: -2000, // hors écran tant que non attaché
    frame: false,
    transparent: false,       // OPAQUE : requis pour SetParent (enfant natif)
    backgroundColor: '#FFFFFF',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    show: false,
    focusable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  _win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay-md.html'));
  _win.on('closed', () => { _win = null; _childHwnd = null; _attachedParent = null; });
  // HWND natif (64-bit) pour SetParent
  try {
    const buf = _win.getNativeWindowHandle();
    _childHwnd = buf.readBigUInt64LE(0).toString();
  } catch (e) {
    try { _childHwnd = String(_win.getNativeWindowHandle().readInt32LE(0)); } catch (e2) { _childHwnd = null; }
  }
  log('Fenetre bouton MD creee (hwnd=' + _childHwnd + ')');
  return _win;
}

async function tick() {
  if (_suspended || _busy) return;
  _busy = true;
  try {
    const r = await findPrinter();
    if (r && r.ok) {
      if (!_win || _win.isDestroyed()) createWindow();
      if (!_childHwnd) { _busy = false; return; }
      const parent = String(r.parent);
      // coords RELATIVES au client du parent (Logos devis window)
      const centerX = Math.round((r.left + r.right) / 2);
      const x = centerX - r.cox - Math.round(MD_SIZE / 2);
      const y = (r.bottom - r.coy) + GAP_BELOW;
      if (_attachedParent !== parent) {
        const ok = await setChildOf(_childHwnd, parent, x, y);
        if (ok) {
          _attachedParent = parent;
          if (_win && !_win.isVisible()) _win.showInactive();
          log('Bouton MD attache a Logos (parent=' + parent + ') sous l imprimante @ ' + x + ',' + y);
        } else {
          log('Echec attache SetParent (parent=' + parent + ')');
        }
      } else {
        // Deja attaché : on réapplique juste la position (au cas où la mise en
        // page a bougé). Réutilise setChildOf (idempotent : re-SetParent + pos).
        await setChildOf(_childHwnd, parent, x, y);
      }
    } else {
      // Fenetre devis absente / Logos pas au premier plan : on détache pour
      // éviter que la destruction du parent n'emporte notre fenetre, et on cache.
      if (_attachedParent && _childHwnd) {
        try { await unsetChild(_childHwnd); } catch (e) {}
        _attachedParent = null;
      }
      if (_win && !_win.isDestroyed() && _win.isVisible()) _win.hide();
    }
  } catch (e) {
    log('tick erreur: ' + e.message);
  } finally {
    _busy = false;
  }
}

function start() {
  createWindow();
  if (_timer) return;
  _timer = setInterval(tick, POLL_MS);
  tick();
  log('Suivi bouton MD demarre (poll ' + POLL_MS + 'ms, mode enfant Logos)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_attachedParent && _childHwnd) { unsetChild(_childHwnd).catch(() => {}); _attachedParent = null; }
  if (_win && !_win.isDestroyed()) { _win.destroy(); _win = null; }
}

/** Suspend/reprend (aligné sur l'overlay pendant l'impression auto). */
function setSuspended(on) {
  _suspended = !!on;
  if (_suspended && _win && !_win.isDestroyed() && _win.isVisible()) _win.hide();
}

module.exports = { setLogger, start, stop, setSuspended };
