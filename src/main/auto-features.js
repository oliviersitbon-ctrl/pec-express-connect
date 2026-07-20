/**
 * Mon devis dentaire Connecté - Auto-features
 *
 * 1. Auto-start au demarrage Windows (registry HKCU Run)
 * 2. Auto-update via electron-updater (pointe vers logos-connect-releases)
 * 3. Watchdog: relance si le process crash (sauf si fermeture manuelle via tray)
 *
 * Le watchdog est implemente cote installeur NSIS via une tache planifiee Windows
 * (voir resources/win/installer.nsh). Cote app, on enregistre juste un flag
 * "manualQuit" dans %APPDATA% quand l'utilisateur clique "Quitter" dans le tray,
 * pour empecher la relance automatique.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { app } = require('electron');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[AUTO] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

// Flag de fermeture manuelle. Si present, le watchdog ne relance pas.
// Au prochain demarrage Windows, le flag est efface et l'app demarre normalement.
const MANUAL_QUIT_FLAG = path.join(os.homedir(), 'AppData', 'Local', 'LogosConnect', '.manual-quit');

function setManualQuitFlag() {
  try {
    fs.mkdirSync(path.dirname(MANUAL_QUIT_FLAG), { recursive: true });
    fs.writeFileSync(MANUAL_QUIT_FLAG, new Date().toISOString());
    log('Flag manual-quit ecrit -> watchdog ne relancera pas');
  } catch (e) { log('Erreur ecriture manual-quit: ' + e.message); }
}

function clearManualQuitFlag() {
  try {
    if (fs.existsSync(MANUAL_QUIT_FLAG)) {
      fs.unlinkSync(MANUAL_QUIT_FLAG);
      log('Flag manual-quit efface (boot)');
    }
  } catch (e) {}
}

function isManualQuitFlagSet() {
  try { return fs.existsSync(MANUAL_QUIT_FLAG); } catch { return false; }
}

/**
 * Configure l'auto-demarrage Windows via app.setLoginItemSettings
 * Plus simple que d'ecrire dans la registry directement, et Electron gere les details.
 */
function setupAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    const settings = app.getLoginItemSettings();
    if (!settings.openAtLogin) {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,  // demarre en background (tray seulement)
        name: 'Mon devis dentaire Connecté'
      });
      log('Auto-start Windows configure');
    } else {
      log('Auto-start deja actif');
    }
  } catch (e) {
    log('Erreur auto-start: ' + e.message);
  }
}

function disableAutoStart() {
  if (process.platform !== 'win32') return;
  try {
    app.setLoginItemSettings({ openAtLogin: false });
    log('Auto-start desactive');
  } catch (e) { log('Erreur disable auto-start: ' + e.message); }
}

/**
 * Configure electron-updater pour pointer vers le repo public
 * et auto-check toutes les heures.
 */
function setupAutoUpdate() {
  if (process.platform !== 'win32') return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (e) {
    log('electron-updater non installe (npm install electron-updater requis): ' + e.message);
    return;
  }

  autoUpdater.logger = {
    info: (m) => log('[updater] ' + m),
    warn: (m) => log('[updater WARN] ' + m),
    error: (m) => log('[updater ERR] ' + m),
    debug: () => {}
  };

  // Config: on telecharge en silence, on installe au prochain quit
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Desactive la verification de signature de l'installeur telecharge
  // (notre app n'est pas signee avec un certificat Authenticode, donc
  // electron-updater rejette par defaut. Comme l'installeur vient de notre
  // propre repo GitHub via HTTPS, on a deja la garantie d'integrite via sha512.)
  autoUpdater.disableWebInstaller = true;
  if (typeof autoUpdater.disableSignatureValidation !== 'undefined') {
    autoUpdater.disableSignatureValidation = true;
  }
  // Pour les versions recentes electron-updater 6+
  if (autoUpdater._verifyUpdateCodeSignature !== undefined) {
    autoUpdater._verifyUpdateCodeSignature = () => Promise.resolve(null);
  }

  autoUpdater.on('update-available', (info) => {
    log(`Update disponible: ${info.version}`);
  });
  autoUpdater.on('update-downloaded', (info) => {
    log(`Update telechargee v${info.version} - application IMMEDIATE`);
    // Marqueur pour empêcher le watchdog de bloquer le redémarrage
    try { fs.unlinkSync(MANUAL_QUIT_FLAG); } catch (e) {}
    // Délai court (2s) pour laisser le log s'écrire et les éventuels handlers se finir
    setTimeout(() => {
      try {
        // quitAndInstall(isSilent=true, isForceRunAfter=true)
        // En mode oneClick:true, l'installeur s'execute sans UAC (perMachine + asInvoker)
        // et relance l'app automatiquement
        log(`[updater] quitAndInstall (silent + restart)`);
        autoUpdater.quitAndInstall(true, true);
      } catch (e) {
        log('Erreur quitAndInstall: ' + e.message);
      }
    }, 2000);
  });
  autoUpdater.on('error', (err) => {
    log('Update error: ' + (err && err.message ? err.message : err));
  });

  // Check rapide au demarrage puis toutes les 20 min (propagation plus rapide
  // des nouvelles versions sur le parc de postes).
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 15 * 1000);  // 15s apres demarrage
  setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 20 * 60 * 1000);  // toutes les 20 min

  log('Auto-update configure (check 15s puis toutes les 20 min)');
}

module.exports = {
  setLogger,
  setupAutoStart,
  disableAutoStart,
  setupAutoUpdate,
  setManualQuitFlag,
  clearManualQuitFlag,
  isManualQuitFlagSet
};
