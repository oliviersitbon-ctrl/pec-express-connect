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
let _busyUntil = 0;     // ms (Date.now) jusqu'auquel l'overlay reste EPINGLE visible
                        // pendant un envoi (l'ouverture de Chrome fait perdre le 1er
                        // plan a Logos ; sans ca la confirmation disparaitrait).
let _lastHideReason = null; // anti-spam : on ne loggue un masquage qu'au changement d'etat
let _hotRect = null;   // zone cliquable des pastilles (px CSS relatifs a la fenetre),
                       // rapportee par le renderer -> pre-arme la capture souris.
let _cursorTimer = null;
let _capturing = false;
let _onDevisActive = null; // callback (throttle) appele quand la page Devis est
                           // detectee -> permet de rafraichir l'etat des modules
                           // (activation/desactivation PEC/Devis) SANS attendre le
                           // refresh periodique (15 min). Le bouton disparait vite.
let _lastActiveRefresh = 0;
const ACTIVE_REFRESH_THROTTLE_MS = 20000;
let _lastOverlayInfo = null; // dernier etat envoye au renderer (re-notif post-refresh)

const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 32;
// Duree d'epinglage apres un clic (ms) : couvre l'envoi + les ~5 s "Envoye".
const BUSY_PIN_MS = 30000;
// Marge SOUS le bas du bouton « Éclater le devis » : place les pastilles PLUS
// BAS que la petite ligne de separation de cette rangee (regle Fiona). Cette
// regle est VOLONTAIRE : ne pas repositionner les boutons ailleurs.
const ROW_GAP_BELOW = 12;

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
  // souris est pre-armee par le MAIN (startCursorPoll) des que le curseur entre
  // dans la zone des pastilles (_hotRect rapporte par le renderer) -> le 1er
  // clic est pris en compte, sans zone de drag. forward:true => le renderer
  // recoit quand meme les mouvements souris (effets hover).
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
function positionOverlayAbsolute(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  if (!logos || typeof logos.logosLeft !== 'number') return;
  const x = logos.logosLeft + logos.logosWidth - OVERLAY_WIDTH - 6;
  // Ancre SOUS le bas du bouton « Éclater le devis » (rowBottom, fourni par le
  // detecteur) + marge -> les pastilles sont PLUS BAS que la ligne de cette
  // rangee. Repli sur l'ancienne position si rowBottom absent.
  const y = (typeof logos.rowBottom === 'number' && logos.rowBottom > 0)
    ? logos.rowBottom + ROW_GAP_BELOW
    : logos.logosTop + 44;
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
  _lastHideReason = null; // reset : le prochain masquage sera logue une fois
}

function hideOverlay() {
  // Epinglage: pendant un envoi (clic PEC/devis), on garde l'overlay visible
  // BUSY_PIN_MS meme si Logos perd le premier plan (Chrome s'ouvre devant) ->
  // la confirmation « Envoi en cours / ✓ Envoye » reste visible sans disparaitre.
  // EXCEPTION: en suspension explicite (impression du devis), on DOIT masquer
  // pour ne pas gener le clic imprimante simule -> l'epinglage ne s'applique pas.
  if (!_suspended && Date.now() < _busyUntil) return;
  if (_overlayWin && _overlayWin.isVisible()) {
    _overlayWin.hide();
    if (_lastHideReason !== 'hidden') { log('Overlay CACHE'); _lastHideReason = 'hidden'; }
  }
}

/**
 * Ré-affiche l'overlay et le maintient ÉPINGLÉ quelques secondes pour que la
 * confirmation « ✓ Envoyé » / « ✓ Ouvert » (affichée côté renderer au retour de
 * l'action) soit RÉELLEMENT visible. Sans ça, après l'impression (suspension),
 * l'overlay reste masqué tant que Logos n'est pas redevenu la fenêtre active
 * (dialogue d'impression qui se ferme, Chrome qui s'ouvre pour la PEC) → la
 * confirmation ne s'afficherait jamais. On force donc le show + on prolonge le
 * busy-pin ; la détection normale reprend et masquera l'overlay une fois le pin
 * expiré si on n'est plus sur la page Devis.
 */
function keepVisibleForConfirmation(ms) {
  const dur = typeof ms === 'number' && ms > 0 ? ms : 5000;
  _busyUntil = Math.max(_busyUntil, Date.now() + dur);
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  if (!_overlayWin.isVisible()) {
    try { _overlayWin.showInactive(); log('Overlay ré-affiché (confirmation ✓)'); } catch (e) {}
  }
}

/**
 * Envoie infos patient/devis au renderer overlay pour affichage
 */
function updateOverlayInfo(info) {
  _lastOverlayInfo = info; // memorise pour re-notifier apres un refresh modules
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
      if (_lastHideReason !== r.reason) { log(`Logos = absent | raison=${r.reason}`); }
      _currentDevisInfo = null;
      _busyUntil = 0; // Logos fermé -> l'épinglage d'envoi n'a plus lieu d'être
      hideOverlay();
      return;
    }

    // Pas sur la page Devis (Logos au 2nd plan, ou aucune page devis ouverte :
    // reason 'no-devis-window' / 'logos-not-foreground' / transitoire) ->
    // MASQUER. Sinon les pastilles grisées restent affichées quand le devis est
    // fermé (régression signalée). L'épinglage d'envoi (_busyUntil) est respecté
    // par hideOverlay, donc la confirmation reste visible pendant un envoi.
    if (!r.active) {
      // Envoi en cours (busy-pin) : l'overlay reste ÉPINGLÉ visible. MAIS
      // l'épinglage ne doit protéger QUE contre une bascule d'APPLICATION
      // (Chrome s'ouvre devant Logos pendant un envoi -> 'logos-not-foreground')
      // pour garder la confirmation visible. Si on est TOUJOURS dans Logos mais
      // sur une AUTRE page (état civil… -> 'no-devis-window'), on masque même en
      // busy-pin, sinon les boutons restent affichés hors de la page Devis
      // (régression signalée). On garde _currentDevisInfo tant qu'on épingle.
      const appSwitch = r.reason === 'logos-not-foreground';
      if (appSwitch && Date.now() < _busyUntil) return;
      if (!appSwitch) _busyUntil = 0; // on a quitté la page Devis DANS Logos
      if (_lastHideReason !== (r.reason || 'no-devis')) {
        log(`Pas sur page Devis (raison=${r.reason || '?'}) -> overlay masqué`);
      }
      // On NE remet PAS _currentDevisInfo à null ici : l'overlay est masqué (donc
      // pas de clic possible), et le garder évite un "trou" au ré-affichage du
      // MÊME devis (le bouton reste cohérent et cliquable dès qu'il réapparaît,
      // sans attendre la lecture asynchrone).
      hideOverlay();
      return;
    }

    // On est sur la page Devis de Logos -> afficher (état à déterminer).
    showOverlay(r);

    // Rafraîchit l'état des modules (PEC / Devis) au plus tôt quand on arrive sur
    // la page Devis (throttle 20 s) : si le module a été désactivé côté site, le
    // bouton disparaît en quelques secondes au lieu d'attendre le refresh 15 min.
    if (_onDevisActive) {
      const now = Date.now();
      if (now - _lastActiveRefresh > ACTIVE_REFRESH_THROTTLE_MS) {
        _lastActiveRefresh = now;
        try {
          Promise.resolve(_onDevisActive()).then(() => {
            // Re-notifie le renderer -> il relit les modules et masque le bouton
            // si un module vient d'être désactivé, sans attendre un nouvel
            // événement foreground.
            if (_lastOverlayInfo) updateOverlayInfo(_lastOverlayInfo);
          }).catch(() => {});
        } catch (e) {}
      }
    }

    if (r.devisId && r.patient) {
      // Anti-course : si le devis affiché DIFFÈRE de celui déjà validé (ou qu'on
      // n'en a aucun), on GRISE le bouton le temps de la lecture asynchrone ->
      // pas de clic "dans le trou" (sinon "pas de devis actif"). Si c'est le MÊME
      // devis, on garde le bouton actif (pas de clignotement, clic immédiat OK).
      const sameDevis = _currentDevisInfo &&
        String(_currentDevisInfo.devisId) === String(r.devisId);
      if (!sameDevis) {
        _currentDevisInfo = null;
        updateOverlayInfo({ enabled: false, reason: 'Lecture du devis…' });
      }

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
      // Sur la page Devis mais devis pas encore lu (chargement) -> grisé.
      _currentDevisInfo = null;
      updateOverlayInfo({ enabled: false, reason: 'Devis en cours de lecture' });
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
 * Poll du curseur : quand il survole la zone des pastilles (_hotRect, rapportee
 * par le renderer), on ACTIVE la capture souris (setIgnoreMouseEvents(false))
 * AVANT tout clic -> le 1er clic est pris en compte. Sinon la fenetre reste
 * traversante et les icones Logos dessous restent cliquables.
 */
function startCursorPoll() {
  if (_cursorTimer) return;
  _cursorTimer = setInterval(() => {
    try {
      if (!_overlayWin || _overlayWin.isDestroyed() || !_overlayWin.isVisible() || !_hotRect) {
        if (_capturing) { _capturing = false; try { _overlayWin && _overlayWin.setIgnoreMouseEvents(true, { forward: true }); } catch (e) {} }
        return;
      }
      const b = _overlayWin.getBounds();
      const p = screen.getCursorScreenPoint();
      const left = b.x + _hotRect.x, top = b.y + _hotRect.y;
      const inside = p.x >= left && p.x <= left + _hotRect.w && p.y >= top && p.y <= top + _hotRect.h;
      if (inside !== _capturing) {
        _capturing = inside;
        _overlayWin.setIgnoreMouseEvents(!inside, { forward: true });
      }
    } catch (e) {}
  }, 90);
}

function stopCursorPoll() {
  if (_cursorTimer) { clearInterval(_cursorTimer); _cursorTimer = null; }
  _capturing = false;
}

/**
 * Handler IPC: appele quand l'utilisateur clique sur "Lancer la PEC"
 */
function setupIpcHandlers() {
  // Bascule click-through / capture, pilote par le survol des pastilles cote
  // renderer (conserve en secours). Le pilotage principal se fait cote MAIN via
  // startCursorPoll (pre-arme la capture avant le clic).
  ipcMain.on('overlay-set-ignore', (event, ignore) => {
    if (_overlayWin && !_overlayWin.isDestroyed()) {
      try { _overlayWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch (e) {}
    }
  });

  // Le renderer rapporte la zone cliquable des pastilles (px CSS relatifs a la
  // fenetre). startCursorPoll s'en sert pour pre-armer la capture souris AVANT
  // le clic -> plus de "1er clic ignore", sans zone de drag.
  ipcMain.on('overlay-set-hot-rect', (event, rect) => {
    _hotRect = rect && typeof rect.w === 'number' ? rect : null;
  });

  ipcMain.handle('overlay-lancer-pec', async (event, intent) => {
    log('=== CLIC LANCER LA PEC ===');
    if (!_currentDevisInfo) {
      log('Pas de devis actif detecte');
      return { success: false, error: 'no-devis-active' };
    }
    log(`Devis: ${_currentDevisInfo.devisId} | Patient: ${_currentDevisInfo.patient}`);

    // EPINGLE l'overlay visible pendant l'envoi + la confirmation (Chrome passe
    // devant Logos, la detection le masquerait sinon).
    _busyUntil = Date.now() + BUSY_PIN_MS;
    if (_overlayWin && !_overlayWin.isDestroyed() && !_overlayWin.isVisible()) {
      try { _overlayWin.showInactive(); } catch (e) {}
    }

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
 * Enregistre un callback appelé (au plus une fois toutes les 20 s) quand la page
 * Devis de Logos est détectée. Sert à rafraîchir vite l'état des modules
 * (PEC/Devis) : une désactivation côté site masque le bouton en quelques
 * secondes, sans attendre le refresh périodique.
 */
function setOnDevisActive(fn) {
  _onDevisActive = fn;
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
  startCursorPoll();
}

/**
 * Stop tout
 */
function stopOverlay() {
  stopWatcher();
  stopCursorPoll();
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
  keepVisibleForConfirmation,
  setOnDevisActive,
  setSuspended,
  readCurrentDevis // re-export pour faciliter
};
