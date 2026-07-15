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

const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 32;

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
  _overlayWin.setIgnoreMouseEvents(false); // doit recevoir les clics

  _overlayWin.on('closed', () => { _overlayWin = null; });
  log('Overlay window cree (cache au demarrage)');
  return _overlayWin;
}

/**
 * Positionne l'overlay en coordonnees ABSOLUES ecran, calculees depuis
 * les coordonnees actuelles de Logos. Pas de SetParent (qui casse le rendu
 * Electron transparent), mais re-positionnement frequent via WinEvent.
 */
function positionOverlayAbsolute(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  if (!logos || typeof logos.logosLeft !== 'number') return;
  const x = logos.logosLeft + logos.logosWidth - OVERLAY_WIDTH - 6;
  const y = logos.logosTop + 44;
  try {
    _overlayWin.setBounds({ x, y, width: OVERLAY_WIDTH, height: OVERLAY_HEIGHT });
  } catch (e) {}
}

function showOverlay(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) createOverlay();
  if (!_overlayWin) return;
  // Repositionner avant d'afficher (coords absolues ecran calculees depuis Logos)
  if (logos && typeof logos.logosLeft === 'number') {
    positionOverlayAbsolute(logos);
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
  if (_detectionInflight) return;
  _detectionInflight = true;
  try {
    const r = await detectDevisPage();

    if (r.reason === 'logos-not-running' || r.reason === 'logos-not-foreground') {
      // Logos n'est pas en avant -> cacher completement
      log(`Logos = absent | raison=${r.reason}`);
      _currentDevisInfo = null;
      hideOverlay();
      return;
    }

    // Logos est foreground -> afficher le bouton (etat a determiner)
    showOverlay(r);

    if (r.active && r.devisId && r.patient) {
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
      log(`Logos foreground mais pas page Devis -> BOUTON GRISE | raison=${r.reason || 'unknown'}`);
      _currentDevisInfo = null;
      updateOverlayInfo({ enabled: false, reason: 'Pas sur page Devis' });
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
  readCurrentDevis // re-export pour faciliter
};
