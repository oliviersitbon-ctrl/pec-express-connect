/**
 * Popup de blocage « jolie » et TOUJOURS au premier plan.
 *
 * Remplace le dialog natif (dialog.showMessageBoxSync) qui, le connecteur étant
 * tray-only (sans fenêtre parente), passait DERRIÈRE Logos et restait invisible.
 * Ici : une vraie BrowserWindow frameless, transparente, alwaysOnTop niveau
 * screen-saver, centrée, stylée (carte blanche + accent). Utilisée pour les
 * blocages « appeler Olivier » : praticien sans compte MDD, devis non analysable.
 *
 * Usage (fire-and-forget) : require('./block-popup').show({ heading, message,
 * phone, tone }). La fenêtre vit seule jusqu'au clic « J'ai compris ».
 */
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(m) { const s = '[BLOCK-POPUP] ' + m; if (_logger) _logger(s); else console.log(s); }

let _win = null;
let _data = null;
let _ipcReady = false;

function setupIpcOnce() {
  if (_ipcReady) return;
  _ipcReady = true;
  // Le renderer récupère son contenu au chargement (pas de course d'IPC).
  ipcMain.handle('block-popup-get', () => _data || {});
  ipcMain.on('block-popup-close', () => {
    if (_win && !_win.isDestroyed()) { try { _win.close(); } catch (e) {} }
  });
}

/**
 * Affiche la popup de blocage. Ferme une éventuelle popup précédente.
 * @param {{heading?:string, message?:string, phone?:string, tone?:'blocked'|'error'|'info'}} data
 */
function show(data) {
  try {
    setupIpcOnce();
    _data = {
      heading: (data && data.heading) || 'Action bloquée',
      message: (data && data.message) || '',
      phone: (data && data.phone) || '',
      tone: (data && data.tone) || 'blocked',
    };
    if (_win && !_win.isDestroyed()) { try { _win.close(); } catch (e) {} _win = null; }

    _win = new BrowserWindow({
      width: 460,
      height: 340,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      center: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      hasShadow: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });
    // Au-dessus de tout, y compris une fenêtre Logos maximisée/alwaysOnTop.
    _win.setAlwaysOnTop(true, 'screen-saver');
    _win.loadFile(path.join(__dirname, '..', 'renderer', 'block-popup.html'));
    _win.once('ready-to-show', () => {
      try { _win.show(); _win.focus(); } catch (e) {}
    });
    _win.on('closed', () => { _win = null; });
    log('affichée: ' + _data.heading);
  } catch (e) {
    log('erreur affichage: ' + e.message);
  }
}

module.exports = { setLogger, show };
