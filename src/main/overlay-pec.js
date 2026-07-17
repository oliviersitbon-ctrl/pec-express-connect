/**
 * Overlay "Lancer la PEC" pour Logos
 *
 * - Fenetre BrowserWindow frameless, transparent, alwaysOnTop, top-right ecran
 * - Visible UNIQUEMENT quand l'utilisateur est sur la page Devis de Logos
 * - Au clic: lit le devis en RAM Logos + construit URL Mon devis dentaire + ouvre Chrome
 */

const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('path');
const { detectDevisPage, setLogger: setDetLogger } = require('./logos-detector');
const { readCurrentDevis, setLogger: setMemLogger } = require('./logos-memory-reader');
const { setChildOf, unsetChild, setLogger: setW32Logger } = require('./win32-utils');

let _logger = null;
function setLogger(fn) {
  _logger = fn;
  setDetLogger(fn);
  setMemLogger(fn);
  setW32Logger(fn);
}
function log(msg) {
  const full = `[OVERLAY] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

let _overlayWin = null;
let _watcherProc = null;
let _onLancerPec = null;
let _currentDevisInfo = null;
let _detectionInflight = false;
let _attachedParentHwnd = null; // HWND du parent Logos auquel on est attache
let _suspended = false; // quand true: overlay masque + detection en pause (ex: pendant l'impression auto)

const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 32;

// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  RÈGLE DE POSITIONNEMENT DES 2 PASTILLES FLOTTANTES — VERROUILLÉE (Fiona) ║
// ║  ⛔ NE PAS MODIFIER, NE PAS RÉ-ANCRER AILLEURS SANS ACCORD DE FIONA. ⛔     ║
// ╠══════════════════════════════════════════════════════════════════════════╣
// ║  ORDONNÉE (Y) — RÈGLE PRINCIPALE :                                        ║
// ║    Les boutons doivent être PLUS BAS que la petite ligne située SOUS le   ║
// ║    bouton « Éclater le devis ». On ancre donc TOUJOURS sur le BAS (Bottom)║
// ║    du bouton « Éclater le devis » détecté dans Logos, + une marge fixe    ║
// ║    descendante (BTN_ANCHOR.Y_BELOW_ECLATER).                              ║
// ║    ❌ NE JAMAIS ancrer sur le haut de la fenêtre Logos (logos.logosTop) : ║
// ║       cette valeur est INSTABLE et fait REMONTER les boutons. C'est       ║
// ║       l'erreur commise par d'autres sessions — ne pas la refaire.         ║
// ║                                                                            ║
// ║  ABSCISSE (X) :                                                           ║
// ║    Le BORD DROIT du bouton de droite doit être un PEU à GAUCHE du bouton  ║
// ║    « Imprimer » de Logos. On ancre sur le bord droit (Right) d'« Imprimer»║
// ║    moins la largeur de l'overlay moins un petit gap                       ║
// ║    (BTN_ANCHOR.X_GAP_LEFT_OF_IMPRIMER).                                   ║
// ║                                                                            ║
// ║  Si les boutons apparaissent trop HAUT ou trop BAS, on n'agit QUE sur les ║
// ║  deux valeurs ci-dessous. On ne change PAS la logique d'ancrage.          ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const BTN_ANCHOR = Object.freeze({
  // Marge (px) sous le BAS du bouton « Éclater le devis ». Doit rester > 0 pour
  // passer SOUS la petite ligne de séparation. Augmenter pour descendre.
  Y_BELOW_ECLATER: 12,
  // Écart (px) entre le bord droit des pastilles et le bord droit d'« Imprimer ».
  X_GAP_LEFT_OF_IMPRIMER: 8,
});

/**
 * Cree la fenetre overlay (cachee au demarrage).
 */
function createOverlay() {
  if (_overlayWin && !_overlayWin.isDestroyed()) return _overlayWin;

  _overlayWin = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: 0, y: 0, // sera repositionne avant chaque show()
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false, // pas de focus -> ne vole pas le focus Logos
    hasShadow: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });

  _overlayWin.loadFile(path.join(__dirname, '..', 'renderer', 'overlay-button.html'));
  _overlayWin.setAlwaysOnTop(true, 'screen-saver');
  // Click-through PAR DEFAUT : le praticien peut cliquer les icones de Logos
  // situees sous l'overlay a tout moment (PDF, @, imprimante...). La capture
  // souris n'est reactivee que lorsque le curseur survole les 2 pastilles
  // flottantes (le renderer overlay-button.html pilote ce basculement via
  // window.cabflow.setMouseIgnore). forward:true => le renderer recoit quand meme
  // les mouvements souris, indispensable pour detecter le survol.
  _overlayWin.setIgnoreMouseEvents(true, { forward: true });

  _overlayWin.on('closed', () => { _overlayWin = null; });
  log('Overlay window cree (cache au demarrage)');
  return _overlayWin;
}

/**
 * Positionne l'overlay en coordonnees ABSOLUES ecran, calculees depuis
 * les coordonnees actuelles de Logos. Pas de SetParent (qui casse le rendu
 * Electron transparent), mais re-positionnement frequent via WinEvent.
 */
// Repère, en coordonnées ÉCRAN, le bouton « Imprimer » (pour l'axe X) et
// « Éclater le devis » (pour l'axe Y) dans la fenêtre devis Logos au premier
// plan. Ancrage STABLE (indépendant du haut de fenêtre, qui varie selon l'état).
const PS_FIND_ANCHORS = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OA {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
if (-not $proc) { Write-Output '{"ok":false}'; exit 0 }
$logosPid = $proc.Id
$fg = [OA]::GetForegroundWindow(); $fgPid = 0
[OA]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
if ($fgPid -ne $logosPid) { Write-Output '{"ok":false}'; exit 0 }
$script:pr = $null; $script:ec = $null
$cbChild = [OA+EnumProc]{ param($h,$l)
  $cls = New-Object System.Text.StringBuilder(64); [OA]::GetClassName($h,$cls,64) | Out-Null
  if ($cls.ToString() -match "Button") {
    $sb = New-Object System.Text.StringBuilder(128); [OA]::GetWindowText($h,$sb,128) | Out-Null
    $t = $sb.ToString()
    if ($t -match "Imprimer" -and -not $script:pr) { $r=New-Object OA+RECT; [OA]::GetWindowRect($h,[ref]$r)|Out-Null; $script:pr=$r }
    if ($t -match "clater le devis" -and -not $script:ec) { $r=New-Object OA+RECT; [OA]::GetWindowRect($h,[ref]$r)|Out-Null; $script:ec=$r }
  }
  return $true
}
$cbTop = [OA+EnumProc]{ param($h,$l)
  if ([OA]::IsWindowVisible($h)) {
    $pp=0; [OA]::GetWindowThreadProcessId($h,[ref]$pp)|Out-Null
    if ($pp -eq $logosPid) { [OA]::EnumChildWindows($h,$cbChild,[IntPtr]::Zero)|Out-Null }
  }
  return $true
}
[OA]::EnumWindows($cbTop,[IntPtr]::Zero) | Out-Null
$o = @{ ok = $true }
if ($script:pr) { $o.pLeft=$script:pr.Left; $o.pRight=$script:pr.Right }
if ($script:ec) { $o.eBottom=$script:ec.Bottom; $o.eTop=$script:ec.Top }
Write-Output (ConvertTo-Json $o -Compress)
`;

function findDevisToolbarAnchors() {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass', '-Command', PS_FIND_ANCHORS,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    proc.stdout.on('data', (d) => (out += d.toString('utf8')));
    const to = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(null); }, 2500);
    proc.on('close', () => {
      clearTimeout(to);
      try {
        const line = out.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
        resolve(line ? JSON.parse(line) : null);
      } catch (e) { resolve(null); }
    });
    proc.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

async function positionOverlayAbsolute(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  if (!logos || typeof logos.logosLeft !== 'number') return;
  // ⚠️ Fallback UNIQUEMENT si la détection PowerShell des boutons échoue.
  //    Ce n'est PAS l'emplacement voulu (il ancre sur le haut de fenêtre) : il
  //    ne sert qu'à éviter des boutons hors écran le temps qu'un ancrage réussi
  //    reprenne la main au prochain cycle. L'emplacement CORRECT est calculé
  //    plus bas à partir de eBottom (bas du bouton « Éclater le devis »).
  let x = logos.logosLeft + logos.logosWidth - OVERLAY_WIDTH - 6;
  let y = logos.logosTop + 44;
  try {
    const a = await findDevisToolbarAnchors();
    if (a && a.ok) {
      // ── RÈGLE VERROUILLÉE (voir bloc BTN_ANCHOR en haut du fichier) ──────────
      // X : bord droit des pastilles un PEU à GAUCHE du bouton « Imprimer ».
      if (typeof a.pRight === 'number') x = Math.round(a.pRight) - OVERLAY_WIDTH - BTN_ANCHOR.X_GAP_LEFT_OF_IMPRIMER;
      // Y : PLUS BAS que la ligne sous « Éclater le devis » => ancrage sur le
      //     BAS (eBottom) du bouton « Éclater le devis » + marge descendante.
      //     ❌ NE JAMAIS remplacer par logos.logosTop (fait remonter les boutons).
      if (typeof a.eBottom === 'number') y = Math.round(a.eBottom) + BTN_ANCHOR.Y_BELOW_ECLATER;
    }
  } catch (e) {}
  try {
    _overlayWin.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  } catch (e) {}
}

async function showOverlay(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) createOverlay();
  if (!_overlayWin) return;
  // Repositionner avant d'afficher (ancrage stable sur imprimante + « Éclater »)
  if (logos && typeof logos.logosLeft === 'number') {
    await positionOverlayAbsolute(logos);
  }
  if (!_overlayWin.isVisible()) {
    _overlayWin.showInactive();
    log('Overlay AFFICHE');
  }
}

function hideOverlay() {
  if (_overlayWin && _overlayWin.isVisible()) {
    _overlayWin.hide();
    log('Overlay CACHE');
  }
}

/**
 * Envoie infos patient/devis au renderer overlay pour affichage
 */
function updateOverlayInfo(info) {
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  try {
    _overlayWin.webContents.send('overlay-info', info);
  } catch (e) {}
}

/**
 * Met a jour le bouton selon l'etat actuel de Logos.
 * Appele a chaque fois qu'une fenetre devient au premier plan.
 */
async function refreshDevisDetection() {
  if (_suspended) { hideOverlay(); return; } // pause pendant l'impression auto
  if (_detectionInflight) return;
  _detectionInflight = true;
  try {
    const r = await detectDevisPage();

    if (r.reason === 'logos-not-running') {
      // Logos n'est pas en avant -> cacher completement
      log(`Logos = absent | raison=${r.reason}`);
      _currentDevisInfo = null;
      hideOverlay();
      return;
    }

    if (r.active && r.devisId && r.patient) {
      // Sur la page Devis UNIQUEMENT : on affiche l'overlay (grisé si devis vide).
      await showOverlay(r);
      // Page Devis detectee, verifier que le devis a des actes en RAM
      // IMPORTANT: filtrer par nom patient pour eviter de lire un vieux devis cache
      let hasActes = false;
      let acteCount = 0;
      try {
        // Le nom patient est "NOM Prenom" - on prend juste la partie NOM (avant l'espace)
        // pour le filtre car le nomPatient="..." dans Logos peut etre composé
        const nomOnly = r.patient.split(' ')[0]; // ex: "DA" pour "DA SILVA VARELA Joana..."
        // On va filtrer par le nom complet en majuscules (avant le prenom)
        // Heuristique: tokens en MAJUSCULES jusqu'au 1er token Capitalisé
        const tokens = r.patient.split(/\s+/);
        const nomTokens = [];
        for (const t of tokens) {
          if (/^[A-ZÀ-Ü][A-ZÀ-Ü\-']*$/.test(t)) nomTokens.push(t);
          else break;
        }
        const filter = nomTokens.length > 0 ? nomTokens.join(' ') : nomOnly;

        const memData = await readCurrentDevis({ patientFilter: filter });
        if (memData.success && memData.actes && memData.actes.length > 0) {
          hasActes = true;
          acteCount = memData.actes.length;
        }
      } catch (e) {}

      if (hasActes) {
        log(`Logos page Devis = OUI | devisId=${r.devisId} patient=${r.patient} | ${acteCount} actes -> BOUTON ROSE`);
        _currentDevisInfo = {
          devisId: r.devisId,
          patient: r.patient,
          devisHwnd: r.devisHwnd,
          patientHwnd: r.patientHwnd
        };
        updateOverlayInfo({ enabled: true, patient: r.patient, devisId: r.devisId });
      } else {
        log(`Logos page Devis = OUI mais 0 actes -> BOUTON GRISE`);
        _currentDevisInfo = null;
        updateOverlayInfo({ enabled: false, reason: 'Devis vide' });
      }
    } else {
      // PAS sur la page Devis -> on MASQUE complètement l'overlay (plus de bouton
      // grisé qui traîne sur la fiche patient ou ailleurs).
      log(`Logos foreground mais pas page Devis -> OVERLAY CACHE | raison=${r.reason || 'unknown'}`);
      _currentDevisInfo = null;
      hideOverlay();
    }
  } catch (e) {
    log('refreshDevisDetection erreur: ' + e.message);
  } finally {
    _detectionInflight = false;
  }
}

/**
 * Lance un watcher PowerShell qui ecoute SetWinEventHook(EVENT_SYSTEM_FOREGROUND).
 * Chaque changement de fenetre au premier plan emet une ligne FOREGROUND sur stdout.
 * On declenche la detection a chaque emission (au lieu de poller).
 */
function startWatcher() {
  if (_watcherProc) return;

  const { spawn } = require('child_process');
  const psScript = String.raw`
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FGHook {
    public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int pt_x; public int pt_y; }
    public const uint EVENT_SYSTEM_FOREGROUND = 3;
    public const uint WINEVENT_OUTOFCONTEXT = 0;
}
"@ -ErrorAction SilentlyContinue
[Console]::Out.WriteLine("HOOK_READY")
[Console]::Out.Flush()
$cb = [FGHook+WinEventDelegate]{
    param($hHook, $eType, $hwnd, $idObj, $idChild, $thread, $time)
    [Console]::Out.WriteLine("FOREGROUND " + $hwnd.ToInt64())
    [Console]::Out.Flush()
}
$hook = [FGHook]::SetWinEventHook([FGHook]::EVENT_SYSTEM_FOREGROUND, [FGHook]::EVENT_SYSTEM_FOREGROUND, [IntPtr]::Zero, $cb, 0, 0, [FGHook]::WINEVENT_OUTOFCONTEXT)
$msg = New-Object FGHook+MSG
while ([FGHook]::GetMessage([ref]$msg, [IntPtr]::Zero, 0, 0) -gt 0) {
    [FGHook]::TranslateMessage([ref]$msg) | Out-Null
    [FGHook]::DispatchMessage([ref]$msg) | Out-Null
}
[FGHook]::UnhookWinEvent($hook) | Out-Null
`;

  _watcherProc = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass',
    '-Command', psScript
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

  let buffer = '';
  _watcherProc.stdout.on('data', (data) => {
    buffer += data.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line === 'HOOK_READY') {
        log('WinEvent hook foreground actif (declencheur evenementiel)');
        // Detection initiale (cas ou Logos est deja au premier plan au demarrage)
        refreshDevisDetection();
        continue;
      }
      if (line.startsWith('FOREGROUND ')) {
        // Changement de fenetre detecte -> verifie si on est sur Logos page Devis
        refreshDevisDetection();
      }
    }
  });

  _watcherProc.stderr.on('data', (d) => {
    const m = d.toString('utf8').trim();
    if (m) log('Watcher stderr: ' + m.slice(0, 200));
  });

  _watcherProc.on('exit', (code) => {
    log('Watcher exit code=' + code);
    _watcherProc = null;
  });

  log('Watcher foreground demarre');
}

function stopWatcher() {
  if (_watcherProc) {
    try { _watcherProc.kill(); } catch (e) {}
    _watcherProc = null;
  }
}

/**
 * Handler IPC: appele quand l'utilisateur clique sur "Lancer la PEC"
 */
function setupIpcHandlers() {
  // Bascule click-through / capture, pilote par le survol des pastilles cote
  // renderer. Quand le curseur quitte les boutons -> ignore=true (traversant)
  // -> les icones Logos dessous redeviennent cliquables.
  ipcMain.on('overlay-set-ignore', (event, ignore) => {
    if (_overlayWin && !_overlayWin.isDestroyed()) {
      try { _overlayWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch (e) {}
    }
  });

  ipcMain.handle('overlay-lancer-pec', async (event, intent) => {
    log('=== CLIC LANCER LA PEC ===');
    if (!_currentDevisInfo) {
      log('Pas de devis actif detecte');
      return { success: false, error: 'no-devis-active' };
    }
    log(`Devis: ${_currentDevisInfo.devisId} | Patient: ${_currentDevisInfo.patient}`);

    if (_onLancerPec) {
      try {
        const result = await _onLancerPec(_currentDevisInfo, intent);
        return { success: true, ...result };
      } catch (e) {
        log('Erreur traitement PEC: ' + e.message);
        return { success: false, error: e.message };
      }
    }
    return { success: false, error: 'no-handler' };
  });
}

/**
 * Enregistre le callback qui sera execute au clic "Lancer la PEC".
 * Le callback recoit { devisId, patient, devisHwnd, patientHwnd } et doit
 * declencher la lecture memoire + ouverture Chrome.
 */
function setOnLancerPec(fn) {
  _onLancerPec = fn;
}

/**
 * Suspend/reprend l'overlay. Suspendu: la fenetre est masquee et la detection
 * ne la reaffiche pas (utilise pendant l'impression auto du devis pour que
 * l'overlay n'intercepte PAS le clic sur l'icone imprimante de Logos).
 */
function setSuspended(on) {
  _suspended = !!on;
  if (_suspended) {
    hideOverlay();
  } else {
    refreshDevisDetection(); // reaffiche selon l'etat courant de Logos
  }
}

/**
 * Demarre tout: cree la fenetre, setup IPC, lance le polling
 */
function startOverlay(onLancerPec) {
  setOnLancerPec(onLancerPec);
  createOverlay();
  setupIpcHandlers();
  startWatcher();
}

/**
 * Stop tout
 */
function stopOverlay() {
  stopWatcher();
  if (_overlayWin && !_overlayWin.isDestroyed()) {
    _overlayWin.destroy();
    _overlayWin = null;
  }
}

module.exports = {
  setLogger,
  startOverlay,
  stopOverlay,
  showOverlay,
  hideOverlay,
  setSuspended,
  readCurrentDevis // re-export pour faciliter
};
