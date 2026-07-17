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
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
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

# 1) Collecter les fenetres top-level Logos visibles (titre + hwnd).
$wins = New-Object System.Collections.ArrayList
$cbTop = [FD+EnumProc]{ param($h,$l)
  if ([FD]::IsWindowVisible($h) -and -not [FD]::IsIconic($h)) {
    $pp=0; [FD]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $pid0) {
      $sb=New-Object System.Text.StringBuilder(512); [FD]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object FD+RECT; [FD]::GetWindowRect($h,[ref]$r) | Out-Null
      if (($r.Right-$r.Left) -gt 300 -and ($r.Bottom-$r.Top) -gt 200) {
        [void]$script:wins.Add([PSCustomObject]@{ HWnd=$h; Id=$h.ToInt64(); Title=$sb.ToString() })
      }
    }
  }
  return $true
}
[FD]::EnumWindows($cbTop,[IntPtr]::Zero) | Out-Null

# 2) Fenetre FICHE = celle qui contient un bouton "Aide" + >=2 marqueurs Etat civil.
#    (La fiche est une fenetre distincte, titre "Fiche d'etat civil".)
$markerRx = "Enregistrer|Lire la carte|Droits en ligne|Espace Sant|carte Vitale"
$ficheId = $null; $ficheHwnd = $null; $aide = $null
foreach ($w in $script:wins) {
  $script:mk = 0; $script:ad = $null
  $cbc = [FD+EnumProc]{ param($h,$l)
    if ([FD]::IsWindowVisible($h)) {
      $cls=New-Object System.Text.StringBuilder(64); [FD]::GetClassName($h,$cls,64) | Out-Null
      if ($cls.ToString() -match "Button") {
        $sb=New-Object System.Text.StringBuilder(128); [FD]::GetWindowText($h,$sb,128) | Out-Null
        $t=$sb.ToString()
        if ($t -match $markerRx) { $script:mk++ }
        if (-not $script:ad -and $t -match "^\s*Aide\s*$") {
          $r=New-Object FD+RECT; [FD]::GetWindowRect($h,[ref]$r) | Out-Null
          $script:ad=[PSCustomObject]@{ L=$r.Left; T=$r.Top; R=$r.Right; B=$r.Bottom }
        }
      }
    }
    return $true
  }
  [FD]::EnumChildWindows($w.HWnd,$cbc,[IntPtr]::Zero) | Out-Null
  if ($script:ad -and $script:mk -ge 2) { $ficheId = $w.Id; $ficheHwnd = $w.HWnd; $aide = $script:ad; break }
}
if (-not $aide) { Write-Output '{"active":false,"reason":"not-etat-civil"}'; exit 0 }

# 3) Lire les CHAMPS de la fiche affichée (contrôles Edit, via WM_GETTEXT). Ces
#    valeurs sont liées au patient RÉELLEMENT à l'écran -> pas d'ambiguïté même
#    si plusieurs dossiers sont ouverts, et DDN fiable (pas de scan RAM).
$edits = New-Object System.Collections.ArrayList
$cbe = [FD+EnumProc]{ param($h,$l)
  if ([FD]::IsWindowVisible($h)) {
    $cls=New-Object System.Text.StringBuilder(48); [FD]::GetClassName($h,$cls,48) | Out-Null
    if ($cls.ToString() -match 'Edit') {
      $sb=New-Object System.Text.StringBuilder(256)
      [FD]::SendMessage($h, 0x000D, [IntPtr]255, $sb) | Out-Null
      $t=$sb.ToString().Trim()
      if ($t.Length -gt 0) {
        $r=New-Object FD+RECT; [FD]::GetWindowRect($h,[ref]$r) | Out-Null
        [void]$script:edits.Add([PSCustomObject]@{ T=$t; L=$r.Left; Top=$r.Top })
      }
    }
  }
  return $true
}
[FD]::EnumChildWindows($ficheHwnd,$cbe,[IntPtr]::Zero) | Out-Null

# NUMERO de dossier = champ "chiffres purs" le plus à DROITE dans la zone haute
# (le "Patient 401" est en haut-droite ; évite le code postal, plus bas/à gauche).
$numero = $null; $numL = -999999
foreach ($e in $script:edits) {
  if ($e.T -match '^\d{1,6}$' -and $e.Top -lt 450 -and $e.L -gt $numL) { $numL = $e.L; $numero = $e.T }
}

# NIR -> année + mois de naissance (pour recouper la DDN).
$nyy = $null; $nmm = $null
foreach ($e in $script:edits) {
  if ($e.T -match '^\s*[12][\s]?(\d{2})[\s]?(\d{2})[\s]?\d{2}') { $nyy = $matches[1]; $nmm = $matches[2]; break }
}

# DDN = champ date JJ/MM/AAAA. Priorité à celle qui recoupe le NIR (mois+année),
# sinon la date la plus HAUTE avec une année de naissance plausible (< année courante).
$dob = $null
$dates = New-Object System.Collections.ArrayList
foreach ($e in $script:edits) { if ($e.T -match '^(\d{2})/(\d{2})/(\d{4})$') { [void]$script:dates.Add($e) } }
if ($nmm -and $nyy) {
  foreach ($e in $script:dates) {
    if ($e.T -match ('^\d{2}/' + [regex]::Escape($nmm) + '/(?:19|20)' + [regex]::Escape($nyy) + '$')) { $dob = $e.T; break }
  }
}
if (-not $dob) {
  $curY = (Get-Date).Year; $minTop = 999999
  foreach ($e in $script:dates) {
    $y = [int]($e.T.Substring(6,4))
    if ($y -ge 1900 -and $y -lt $curY -and $e.Top -lt $minTop) { $minTop = $e.Top; $dob = $e.T }
  }
}

# NOM/PRENOM : fenetre patient dont le titre commence par CE numero (lié à la
# fiche active). Repli : 1re fenetre "<num> - <nom>" si numero non lu.
$name = $null
if ($numero) {
  foreach ($w in $script:wins) {
    if ($w.Title -match ('^' + [regex]::Escape($numero) + '\s*[-–]\s*(.+)$')) { $name = $matches[1].Trim(); break }
  }
}
if (-not $name) {
  foreach ($w in $script:wins) {
    if ($w.Title -match '^(\d+)\s*[-–]\s*(.+)$') { if (-not $numero) { $numero = $matches[1] }; $name = $matches[2].Trim(); break }
  }
}

$obj = @{
  active = $true
  focused = ($fgId -eq $ficheId)
  numero = $numero
  name = $name
  dob = $dob
  aideLeft = $aide.L; aideTop = $aide.T; aideRight = $aide.R; aideBottom = $aide.B
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
    _currentFiche = { nom, prenom, numero: r.numero, dob: r.dob || null };
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
