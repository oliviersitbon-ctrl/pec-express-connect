/**
 * overlay-fiche.js
 *
 * Overlay flottant "Questionnaire MD" pour la page FICHE PATIENT (Etat civil)
 * de Logos. Bouton unique, place JUSTE A GAUCHE du bouton "Aide" (ancre sur sa
 * position reelle -> robuste a la resolution / mise a l'echelle Windows).
 *
 * Visible UNIQUEMENT quand :
 *   - Logos est au premier plan,
 *   - on est sur la page Etat civil (marqueurs: Enregistrer / Lire la carte /
 *     Droits en ligne (ADRi) / Espace Sante ...),
 *   - la fenetre patient est au premier plan.
 *
 * Au clic : lit l'identite patient (nom/prenom via le titre, DDN via la RAM) et
 * appelle le callback fourni par index.js (qui POST /api/questionnaire/enqueue).
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[OVERLAY-FICHE] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

let _win = null;
let _watcherProc = null;
let _pollTimer = null;
let _detectionInflight = false;
let _suspended = false;
let _currentFiche = null;   // { nom, prenom, numero, patientHwnd }
let _onSend = null;         // callback index.js

const OVERLAY_WIDTH = 170;
const OVERLAY_HEIGHT = 30;
const GAP_LEFT_OF_AIDE = 8;  // ecart a gauche du bouton Aide
const POLL_MS = 1500;

// ── Detection page Etat civil + bouton Aide ────────────────────────────────
// Renvoie JSON : { active, reason?, nom?, prenom?, numero?, patientHwnd?,
//   aideLeft?, aideTop?, aideRight?, aideBottom? }
const PS_DETECT = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FD {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output '{"active":false,"reason":"logos-not-running"}'; exit 0 }
$pid0 = $proc.Id

$fg = [FD]::GetForegroundWindow(); $fgPid = 0
[FD]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
if ($fgPid -ne $pid0) { Write-Output '{"active":false,"reason":"logos-not-foreground"}'; exit 0 }
$fgId = $fg.ToInt64()

# Fenetre patient = top-level visible, titre "<num> - <NOM Prenom>", grande.
$patient = $null
$cb = [FD+EnumProc]{ param($h,$l)
  if ($script:patient) { return $true }
  if ([FD]::IsWindowVisible($h) -and -not [FD]::IsIconic($h)) {
    $pp=0; [FD]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $pid0) {
      $sb=New-Object System.Text.StringBuilder(512); [FD]::GetWindowText($h,$sb,512) | Out-Null
      $t=$sb.ToString()
      if ($t -match '^(\d+)\s*-\s*(.+)$') {
        $r=New-Object FD+RECT; [FD]::GetWindowRect($h,[ref]$r) | Out-Null
        if (($r.Right-$r.Left) -gt 900 -and ($r.Bottom-$r.Top) -gt 500) {
          $script:patient=[PSCustomObject]@{ HWnd=$h.ToInt64(); Num=$matches[1]; Name=$matches[2].Trim(); Fg=($h.ToInt64() -eq $fgId) }
        }
      }
    }
  }
  return $true
}
[FD]::EnumWindows($cb,[IntPtr]::Zero) | Out-Null
if (-not $script:patient) { Write-Output '{"active":false,"reason":"no-patient-window"}'; exit 0 }

# Dans la fenetre patient : compter les marqueurs Etat civil + localiser "Aide".
$markerRx = "Enregistrer|Lire la carte|Droits en ligne|ADRi|Espace Sant|Vitale"
$markers = 0
$aide = $null
$cbc = [FD+EnumProc]{ param($h,$l)
  if ([FD]::IsWindowVisible($h)) {
    $cls=New-Object System.Text.StringBuilder(64); [FD]::GetClassName($h,$cls,64) | Out-Null
    if ($cls.ToString() -match "Button") {
      $sb=New-Object System.Text.StringBuilder(128); [FD]::GetWindowText($h,$sb,128) | Out-Null
      $t=$sb.ToString()
      if ($t -match $markerRx) { $script:markers++ }
      if (-not $script:aide -and $t -match "^\s*Aide\s*$") {
        $r=New-Object FD+RECT; [FD]::GetWindowRect($h,[ref]$r) | Out-Null
        $script:aide=[PSCustomObject]@{ L=$r.Left; T=$r.Top; R=$r.Right; B=$r.Bottom }
      }
    }
  }
  return $true
}
[FD]::EnumChildWindows([IntPtr]$script:patient.HWnd,$cbc,[IntPtr]::Zero) | Out-Null

if ($script:markers -lt 2 -or -not $script:aide) {
  Write-Output ('{"active":false,"reason":"not-etat-civil","markers":' + $script:markers + '}')
  exit 0
}

$obj = @{
  active = $true
  focused = [bool]$script:patient.Fg
  numero = $script:patient.Num
  name = $script:patient.Name
  patientHwnd = $script:patient.HWnd
  aideLeft = $script:aide.L; aideTop = $script:aide.T; aideRight = $script:aide.R; aideBottom = $script:aide.B
} | ConvertTo-Json -Compress
Write-Output $obj
`;

function detectFichePage() {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-Command', PS_DETECT,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', d => out += d.toString('utf8'));
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve({ active: false, reason: 'timeout' }); }, 3000);
    proc.on('close', () => {
      clearTimeout(to);
      try {
        const line = out.trim().split('\n').filter(l => l.trim().startsWith('{')).pop();
        resolve(line ? JSON.parse(line) : { active: false, reason: 'no-output' });
      } catch (e) { resolve({ active: false, reason: 'parse-error' }); }
    });
    proc.on('error', () => { clearTimeout(to); resolve({ active: false, reason: 'spawn-error' }); });
  });
}

// Sépare "REY Brigitte" -> { nom:"REY", prenom:"Brigitte" } (tokens MAJ = nom).
function splitName(full) {
  const tokens = String(full || '').split(/\s+/).filter(Boolean);
  const nomTokens = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    if (/^[A-ZÀ-Ü][A-ZÀ-Ü\-']*$/.test(tokens[i])) nomTokens.push(tokens[i]);
    else break;
  }
  const nom = nomTokens.join(' ') || (tokens[0] || '');
  const prenom = tokens.slice(nomTokens.length > 0 ? i : 1).join(' ');
  return { nom: nom.trim(), prenom: prenom.trim() };
}

function createOverlay() {
  if (_win && !_win.isDestroyed()) return _win;
  _win = new BrowserWindow({
    width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT, x: 0, y: 0,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, show: false, focusable: false, hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, '..', 'preload.js') },
  });
  _win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay-fiche.html'));
  _win.setAlwaysOnTop(true, 'screen-saver');
  _win.setIgnoreMouseEvents(true, { forward: true });
  _win.on('closed', () => { _win = null; });
  log('Overlay fiche cree (cache au demarrage)');
  return _win;
}

function toDip(pt) {
  try {
    if (screen && typeof screen.screenToDipPoint === 'function') return screen.screenToDipPoint(pt);
  } catch (e) {}
  return pt;
}

function positionAbsolute(r) {
  if (!_win || _win.isDestroyed()) return;
  if (typeof r.aideLeft !== 'number') return;
  // Bord droit de l'overlay = juste a gauche du bouton Aide ; vertical centre sur Aide.
  const rightPhysical = r.aideLeft - GAP_LEFT_OF_AIDE;
  const aideH = (typeof r.aideBottom === 'number' ? r.aideBottom - r.aideTop : OVERLAY_HEIGHT);
  const topPhysical = r.aideTop + Math.round((aideH - OVERLAY_HEIGHT) / 2);
  const dip = toDip({ x: Math.round(rightPhysical), y: Math.round(topPhysical) });
  const x = Math.round(dip.x - OVERLAY_WIDTH);
  const y = Math.round(dip.y);
  try { _win.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT }); } catch (e) {}
}

function showOverlay(r) {
  if (!_win || _win.isDestroyed()) createOverlay();
  if (!_win) return;
  positionAbsolute(r);
  if (!_win.isVisible()) { _win.showInactive(); log('Overlay fiche AFFICHE'); }
}
function hideOverlay() {
  if (_win && _win.isVisible()) { _win.hide(); log('Overlay fiche CACHE'); }
}

async function refresh() {
  if (_suspended) { hideOverlay(); return; }
  if (_detectionInflight) return;
  _detectionInflight = true;
  try {
    const r = await detectFichePage();
    if (!r || !r.active || r.focused === false) {
      if (r && r.active && r.focused === false) log('Masque : fiche pas au premier plan');
      else if (r && r.reason && r.reason !== 'busy') log('Masque | raison=' + r.reason);
      _currentFiche = null;
      hideOverlay();
      return;
    }
    const { nom, prenom } = splitName(r.name);
    _currentFiche = { nom, prenom, numero: r.numero, patientHwnd: r.patientHwnd };
    showOverlay(r);
    if (_win && !_win.isDestroyed()) {
      try { _win.webContents.send('fiche-info', { patient: (prenom ? prenom + ' ' : '') + nom }); } catch (e) {}
    }
  } catch (e) {
    log('refresh erreur: ' + e.message);
  } finally {
    _detectionInflight = false;
  }
}

function startWatcher() {
  if (_watcherProc) return;
  const psScript = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class FGH2 {
  public delegate void D(IntPtr a, uint b, IntPtr c, int d, int e, uint f, uint g);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint mn, uint mx, IntPtr h, D cb, uint p, uint t, uint f);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
}
"@ -ErrorAction SilentlyContinue
[Console]::Out.WriteLine("HOOK_READY"); [Console]::Out.Flush()
$cb = [FGH2+D]{ param($a,$b,$c,$d,$e,$f,$g) [Console]::Out.WriteLine("FG"); [Console]::Out.Flush() }
$hook = [FGH2]::SetWinEventHook(3,3,[IntPtr]::Zero,$cb,0,0,0)
$m = New-Object FGH2+MSG
while ([FGH2]::GetMessage([ref]$m,[IntPtr]::Zero,0,0) -gt 0) {}
`;
  _watcherProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-Command', psScript,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buf = '';
  _watcherProc.stdout.on('data', (data) => {
    buf += data.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
      if (!line) continue;
      if (line === 'HOOK_READY') { log('WinEvent hook fiche actif'); refresh(); continue; }
      if (line === 'FG') refresh();
    }
  });
  _watcherProc.on('exit', () => { _watcherProc = null; });
  log('Watcher fiche demarre');
}

function stopWatcher() { if (_watcherProc) { try { _watcherProc.kill(); } catch (e) {} _watcherProc = null; } }
function startPoll() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => { if (!_suspended) refresh(); }, POLL_MS);
}
function stopPoll() { if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; } }

function setupIpc() {
  ipcMain.on('overlay-fiche-set-ignore', (event, ignore) => {
    if (_win && !_win.isDestroyed()) { try { _win.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch (e) {} }
  });
  ipcMain.handle('overlay-questionnaire-send', async () => {
    log('=== CLIC QUESTIONNAIRE MD ===');
    if (!_currentFiche || !_currentFiche.nom) return { ok: false, error: 'no-patient' };
    if (!_onSend) return { ok: false, error: 'no-handler' };
    try {
      return await _onSend({ ..._currentFiche });
    } catch (e) {
      log('send erreur: ' + e.message);
      return { ok: false, error: e.message };
    }
  });
}

function setSuspended(on) {
  _suspended = !!on;
  if (_suspended) hideOverlay(); else refresh();
}

function startOverlay(onSend) {
  _onSend = onSend;
  createOverlay();
  setupIpc();
  startWatcher();
  startPoll();
  log('Overlay fiche demarre');
}

function stopOverlay() {
  stopWatcher();
  stopPoll();
  if (_win && !_win.isDestroyed()) { _win.destroy(); _win = null; }
}

module.exports = { setLogger, startOverlay, stopOverlay, setSuspended };
