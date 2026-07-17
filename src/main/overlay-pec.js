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
let _pollTimer = null; // revérification periodique (filet de securite du hook foreground)
let _busyUntil = 0;    // ms (Date.now) jusqu'auquel l'overlay reste EPINGLE visible
                       // pendant un envoi (l'ouverture de Chrome fait perdre le 1er
                       // plan a Logos ; sans ca la confirmation disparaitrait).
let _lastHideReason = null; // anti-spam : on ne loggue un masquage qu'au changement d'etat
let _hotRect = null;   // zone cliquable des pastilles (px CSS relatifs a la fenetre),
                       // rapportee par le renderer -> pre-arme la capture souris.
let _cursorTimer = null;
let _capturing = false;

const OVERLAY_WIDTH = 300;
const OVERLAY_HEIGHT = 32;
// Duree d'epinglage apres un clic (ms) : couvre l'envoi + les ~5 s "Envoye".
const BUSY_PIN_MS = 30000;
// Le hook foreground ne se declenche PAS quand on change de page A L'INTERIEUR
// de Logos (la fenetre top-level ne change pas). On re-verifie donc l'etat a
// intervalle regulier pour masquer l'overlay des qu'on quitte la page Devis
// (et pour le faire disparaitre proprement si Logos se ferme sans event final).
const POLL_MS = 1500;

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
// Ecart vertical sous la ligne de la rangee "Ajouter alternative / Creer
// alternative / Eclater le devis / Voir les a faire". Le bas du bouton "Eclater
// le devis" coincide avec ce trait -> 0 = bord SUPERIEUR de l'overlay pile sur
// la ligne (colle dessous). Ajustable si besoin (valeur positive = plus bas).
const ROW_GAP_BELOW = 12; // marge SOUS le bas du bouton « Éclater le devis » :
                          // place les pastilles PLUS BAS que la petite ligne de
                          // séparation de cette rangée (règle demandée par Fiona).
const PRINTER_GAP_BELOW = 12; // repli : sous l'imprimante
const RIGHT_MARGIN = 8;       // marge par rapport au bord droit de la fenetre

/**
 * Convertit un point en pixels PHYSIQUES ecran vers des pixels LOGIQUES (DIP),
 * pour que le positionnement reste correct meme quand Windows est en mise a
 * l'echelle 125%/150% (setBounds attend des DIP, GetWindowRect renvoie du
 * physique). En 100% ou si l'API n'existe pas -> identite.
 */
function toDip(pt) {
  try {
    if (screen && typeof screen.screenToDipPoint === 'function') {
      return screen.screenToDipPoint(pt);
    }
  } catch (e) {}
  return pt;
}

function positionOverlayAbsolute(logos) {
  if (!_overlayWin || _overlayWin.isDestroyed()) return;
  if (!logos || typeof logos.logosLeft !== 'number') return;

  // Bord droit de reference = bord droit de la fenetre devis (coords physiques).
  const rightEdgePhysical = logos.logosLeft + logos.logosWidth - RIGHT_MARGIN;

  // Ancre verticale, par ordre de preference :
  //  1) sous la rangee "Eclater le devis..." (cible demandee)
  //  2) repli : sous l'imprimante
  //  3) repli : ancien coin haut-droit
  let topPhysical;
  if (typeof logos.rowBottom === 'number') {
    topPhysical = logos.rowBottom + ROW_GAP_BELOW;
  } else if (typeof logos.printerBottom === 'number') {
    topPhysical = logos.printerBottom + PRINTER_GAP_BELOW;
  } else {
    topPhysical = logos.logosTop + 44;
  }

  // Physique -> logique, PUIS on applique la largeur (deja en DIP) pour aligner
  // le bord droit de l'overlay sur le bord droit de la fenetre.
  const dip = toDip({ x: Math.round(rightEdgePhysical), y: Math.round(topPhysical) });
  const x = Math.round(dip.x - OVERLAY_WIDTH);
  const y = Math.round(dip.y);
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
  // Epinglage pendant un envoi : on NE masque PAS (Chrome passe devant Logos et
  // masquerait sinon la confirmation "Envoi en cours / ✓ Envoye").
  if (Date.now() < _busyUntil) return;
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

    // REGLE UNIQUE D'AFFICHAGE : l'overlay n'apparait QUE lorsqu'on est
    // reellement sur la page Devis de Logos (r.active === true).
    // Tous les autres cas -> masquage complet :
    //   - logos-not-running    : Logos ferme
    //   - logos-not-foreground : Logos ouvert mais une autre appli est devant
    //   - no-devis-window      : Logos devant mais autre page (fiche, schema, actes...)
    //   - busy/timeout/parse-error/... : etat transitoire -> on masque par securite
    // => plus de "boutons gris" fantomes hors page devis ou Logos ferme.
    if (!r || !r.active || r.devisFocused === false) {
      // Log UNIQUEMENT au changement d'etat (sinon "Overlay masque" spamme a
      // chaque cycle de poll, toutes les 1,5 s).
      const motif = (r && r.active && r.devisFocused === false)
        ? 'focus-ailleurs'
        : ((r && r.reason) || 'unknown');
      if (motif !== 'busy' && _lastHideReason !== motif) {
        log(motif === 'focus-ailleurs'
          ? 'Overlay masque : fenetre Devis ouverte mais pas au premier plan (focus ailleurs)'
          : `Overlay masque (pas page Devis) | raison=${motif}`);
        _lastHideReason = motif;
      }
      _currentDevisInfo = null;
      hideOverlay();
      return;
    }

    // On est bien sur la page Devis ET elle est au premier plan -> afficher.
    _lastHideReason = null; // reset : le prochain masquage sera logue une fois
    showOverlay(r);

    if (r.devisId && r.patient) {
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
      // Sur la page Devis mais patient/devis non encore identifie -> bouton grise
      // (affiche, car on EST bien sur la page devis, mais non actionnable).
      log(`Logos page Devis = OUI mais patient non identifie -> BOUTON GRISE | raison=${r.reason || 'no-patient'}`);
      _currentDevisInfo = null;
      updateOverlayInfo({ enabled: false, reason: 'Devis' });
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
 * Filet de securite : re-verifie l'etat Logos a intervalle regulier, en plus
 * du hook foreground evenementiel. Necessaire car passer de la page Devis a une
 * autre page DANS Logos ne change pas la fenetre top-level -> aucun event
 * foreground -> sans ce poll, l'overlay resterait affiche hors page Devis.
 * Les gardes _detectionInflight / _detectorBusy evitent tout empilement.
 */
function startPoll() {
  if (_pollTimer) return;
  _pollTimer = setInterval(() => {
    if (_suspended) return;
    refreshDevisDetection();
  }, POLL_MS);
  log('Poll de securite overlay demarre (' + POLL_MS + 'ms)');
}

function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
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
  // renderer. Quand le curseur quitte les boutons -> ignore=true (traversant)
  // -> les icones Logos dessous redeviennent cliquables.
  ipcMain.on('overlay-set-ignore', (event, ignore) => {
    if (_overlayWin && !_overlayWin.isDestroyed()) {
      try { _overlayWin.setIgnoreMouseEvents(!!ignore, { forward: true }); } catch (e) {}
    }
  });

  // Le renderer rapporte la zone cliquable des pastilles (px CSS relatifs a la
  // fenetre). Un poll du curseur (startCursorPoll) pre-arme la capture souris
  // AVANT le clic -> plus de "1er clic ignore", sans zone de drag.
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
  startPoll();
  startCursorPoll();
}

/**
 * Stop tout
 */
function stopOverlay() {
  stopWatcher();
  stopPoll();
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
  setSuspended,
  readCurrentDevis // re-export pour faciliter
};
