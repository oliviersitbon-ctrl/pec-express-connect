/**
 * PecExpress Desktop - System Tray
 * Gestion de l'icône et du menu dans la barre système
 */

const { Tray, Menu, nativeImage, Notification } = require('electron');
const path = require('path');
const log = require('electron-log');

let tray = null;
let currentStatus = 'initializing';
let callbacks = {};

const STATUS_LABELS = {
  initializing: 'Initialisation...',
  ready: 'Prêt',
  processing: 'Traitement en cours...',
  error: 'Erreur',
  offline: 'Hors ligne'
};

/**
 * Obtenir l'icône selon le statut
 */
function getIcon(status) {
  const iconName = status === 'error' ? 'icon-error' : 'icon';
  const ext = process.platform === 'win32' ? 'ico' : 'png';

  // En développement, utiliser le dossier assets
  // En production, utiliser les resources packagées
  const iconPath = path.join(__dirname, `../../assets/${iconName}.${ext}`);

  try {
    return nativeImage.createFromPath(iconPath);
  } catch (error) {
    log.warn('Icône non trouvée:', iconPath);
    return null;
  }
}

/**
 * Créer le menu contextuel
 */
function createContextMenu() {
  return Menu.buildFromTemplate([
    {
      label: `PecExpress Desktop - ${STATUS_LABELS[currentStatus]}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Ouvrir PecExpress',
      click: () => {
        const { shell } = require('electron');
        const { getConfigValue } = require('./config');
        shell.openExternal(getConfigValue('siteUrl'));
      }
    },
    { type: 'separator' },
    {
      label: 'Paramètres',
      click: () => callbacks.onShowSettings?.()
    },
    {
      label: 'Voir les logs',
      click: () => {
        const { shell } = require('electron');
        const logsPath = path.dirname(log.transports.file.getFile().path);
        shell.openPath(logsPath);
      }
    },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => callbacks.onQuit?.()
    }
  ]);
}

/**
 * Initialiser le systray
 */
function initTray(cbs) {
  callbacks = cbs;

  const icon = getIcon('initializing');
  tray = new Tray(icon);

  tray.setToolTip('PecExpress Desktop - Initialisation...');
  tray.setContextMenu(createContextMenu());

  // Double-clic pour ouvrir les paramètres
  tray.on('double-click', () => {
    callbacks.onShowSettings?.();
  });

  log.info('Systray initialisé');
}

/**
 * Mettre à jour le statut du systray
 */
function updateTrayStatus(status) {
  if (!tray) return;

  currentStatus = status;

  const icon = getIcon(status);
  if (icon) {
    tray.setImage(icon);
  }

  tray.setToolTip(`PecExpress Desktop - ${STATUS_LABELS[status]}`);
  tray.setContextMenu(createContextMenu());

  log.info('Statut systray:', status);
}

/**
 * Afficher une notification
 */
function showNotification(title, body, onClick) {
  const { getConfigValue } = require('./config');

  if (!getConfigValue('showNotifications')) {
    return;
  }

  const notification = new Notification({
    title,
    body,
    icon: path.join(__dirname, '../../assets/icon.png'),
    silent: false
  });

  if (onClick) {
    notification.on('click', onClick);
  }

  notification.show();
}

/**
 * Notification de succès
 */
function notifySuccess(message) {
  showNotification('PecExpress Desktop', message, () => {
    const { shell } = require('electron');
    const { getConfigValue } = require('./config');
    shell.openExternal(getConfigValue('siteUrl'));
  });
}

/**
 * Notification d'erreur
 */
function notifyError(message) {
  showNotification('PecExpress Desktop - Erreur', message);
}

module.exports = {
  initTray,
  updateTrayStatus,
  showNotification,
  notifySuccess,
  notifyError
};
