/**
 * PecExpress Desktop v1.6.6 - Renderer Script
 */

console.log('[RENDERER] === DEMARRAGE RENDERER v1.6.6 ===');
console.log('[RENDERER] window.cabflow existe:', !!window.cabflow);
console.log('[RENDERER] Date:', new Date().toISOString());

// Elements DOM
const elements = {
  version: document.getElementById('version'),
  versionBanner: document.getElementById('version-banner'),
  printerStatus: document.getElementById('printer-status'),
  platform: document.getElementById('platform'),
  btnReinstall: document.getElementById('btn-reinstall'),
  btnTest: document.getElementById('btn-test'),
  btnLogs: document.getElementById('btn-logs'),
  btnOpenSite: document.getElementById('btn-open-site'),
  toastContainer: document.getElementById('toast-container'),
  debugInfo: document.getElementById('debug-info')
};

console.log('[RENDERER] Elements DOM charges:', Object.keys(elements).filter(k => elements[k]).length, '/', Object.keys(elements).length);

/**
 * Afficher une notification toast
 */
function showToast(message, type = 'info') {
  console.log('[RENDERER] Toast:', type, message);
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.animation = 'slideIn 0.3s ease reverse';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Mettre a jour le statut de l'imprimante
 */
function updatePrinterStatus(installed) {
  console.log('[RENDERER] Printer status update:', installed);
  const statusEl = elements.printerStatus;

  if (installed) {
    statusEl.innerHTML = '<span class="status-dot success"></span> Installee';
  } else {
    statusEl.innerHTML = '<span class="status-dot error"></span> Non installee';
  }
}

/**
 * Afficher les infos de debug
 */
async function showDebugInfo() {
  console.log('[RENDERER] Chargement debug info...');
  const info = [];

  try {
    const status = await window.cabflow.getStatus();
    info.push('Version app: ' + status.version);
    info.push('Plateforme: ' + status.platform);
    info.push('Imprimante installee: ' + status.printerInstalled);
  } catch (e) {
    info.push('ERREUR getStatus: ' + e.message);
  }

  try {
    const config = await window.cabflow.getConfig();
    info.push('Site URL: ' + (config.siteUrl || 'non defini'));
    info.push('API endpoint: ' + (config.apiEndpoint || 'non defini'));
    info.push('Printer name: ' + (config.printerName || 'non defini'));
  } catch (e) {
    info.push('ERREUR getConfig: ' + e.message);
  }

  info.push('Date/heure: ' + new Date().toLocaleString('fr-FR'));
  info.push('User agent: ' + navigator.userAgent);
  info.push('window.cabflow: ' + (window.cabflow ? 'OK' : 'MANQUANT'));

  if (elements.debugInfo) {
    elements.debugInfo.textContent = info.join('\n');
  }
  console.log('[RENDERER] Debug info:', info);
}

/**
 * Charger le statut
 */
async function loadStatus() {
  console.log('[RENDERER] loadStatus() debut...');
  try {
    const status = await window.cabflow.getStatus();
    console.log('[RENDERER] Status recu:', JSON.stringify(status));

    elements.version.textContent = `v${status.version}`;
    if (elements.versionBanner) {
      elements.versionBanner.textContent = `v${status.version}`;
    }
    elements.platform.textContent = status.platform === 'darwin' ? 'macOS' : 'Windows';
    updatePrinterStatus(status.printerInstalled);
    console.log('[RENDERER] loadStatus() OK');
  } catch (error) {
    console.error('[RENDERER] ERREUR loadStatus:', error);
    elements.printerStatus.innerHTML = '<span class="status-dot error"></span> Erreur';
  }
}

/**
 * Charger et afficher les logs
 */
async function loadAndShowLogs() {
  console.log('[RENDERER] loadAndShowLogs() debut...');
  const logsPanel = document.getElementById('logs-panel');
  const logsContent = document.getElementById('logs-content');
  const logsInfo = document.getElementById('logs-info');

  try {
    const result = await window.cabflow.readLogs();
    console.log('[RENDERER] readLogs result:', result.success, 'path:', result.path);
    if (result.success) {
      logsContent.textContent = result.content;
      logsInfo.textContent = `Fichier: ${result.path} (${result.totalLines} lignes, dernieres 500 affichees)`;
      logsPanel.style.display = 'block';
      logsContent.scrollTop = logsContent.scrollHeight;
    } else {
      logsContent.textContent = 'Erreur: ' + result.error;
      logsPanel.style.display = 'block';
    }
  } catch (e) {
    console.error('[RENDERER] ERREUR readLogs:', e);
    logsContent.textContent = 'Erreur: ' + e.message;
    logsPanel.style.display = 'block';
  }
}

/**
 * Initialisation
 */
async function init() {
  console.log('[RENDERER] init() debut...');

  await loadStatus();
  await showDebugInfo();

  // Bouton reinstaller
  if (elements.btnReinstall) {
    elements.btnReinstall.addEventListener('click', async () => {
      console.log('[RENDERER] Click: Reinstaller imprimante');
      elements.btnReinstall.disabled = true;
      elements.btnReinstall.textContent = 'Installation...';

      try {
        const result = await window.cabflow.reinstallPrinter();
        console.log('[RENDERER] Resultat reinstall:', JSON.stringify(result));

        if (result.success) {
          showToast('Imprimante reinstallee avec succes', 'success');
          updatePrinterStatus(true);
        } else {
          showToast(`Erreur: ${result.error}`, 'error');
          updatePrinterStatus(false);
        }
      } catch (error) {
        console.error('[RENDERER] ERREUR reinstall:', error);
        showToast('Erreur lors de la reinstallation', 'error');
      } finally {
        elements.btnReinstall.disabled = false;
        elements.btnReinstall.textContent = 'Reinstaller l\'imprimante';
      }
    });
  }

  // Bouton definir par defaut
  const btnSetDefault = document.getElementById('btn-set-default');
  if (btnSetDefault) {
    btnSetDefault.addEventListener('click', async () => {
      console.log('[RENDERER] Click: Definir par defaut');
      btnSetDefault.disabled = true;
      btnSetDefault.textContent = 'Configuration...';

      try {
        const result = await window.cabflow.setDefaultPrinter();
        console.log('[RENDERER] Resultat setDefault:', JSON.stringify(result));

        if (result.logs && result.logs.length > 0) {
          console.log('[RENDERER] Logs definition defaut:', result.logs.join('\n'));
        }

        if (result.success) {
          let msg = 'Imprimante definie par defaut avec succes !';
          if (result.warning) msg += '\n(' + result.warning + ')';
          alert(msg + '\n\n' + (result.logs ? result.logs.pop() : ''));
          showToast('Succes', 'success');
        } else {
          const lastLog = result.logs ? result.logs.join('\n') : result.error;
          alert('Echec de la configuration :\n' + lastLog);
          showToast(`Erreur: ${result.error}`, 'error');
        }
      } catch (error) {
        console.error('[RENDERER] ERREUR setDefault:', error);
        showToast('Erreur configuration', 'error');
      } finally {
        btnSetDefault.disabled = false;
        btnSetDefault.textContent = 'Definir par defaut';
      }
    });
  }

  // Bouton test
  if (elements.btnTest) {
    elements.btnTest.addEventListener('click', async () => {
      console.log('[RENDERER] Click: Test impression');
      elements.btnTest.disabled = true;
      elements.btnTest.textContent = 'Test en cours...';

      try {
        const result = await window.cabflow.testPrint();
        console.log('[RENDERER] Resultat test:', JSON.stringify(result));

        if (result.success) {
          showToast('Test reussi', 'success');
        } else {
          showToast(`Erreur: ${result.error}`, 'error');
        }
      } catch (error) {
        console.error('[RENDERER] ERREUR test:', error);
        showToast('Erreur lors du test', 'error');
      } finally {
        elements.btnTest.disabled = false;
        elements.btnTest.textContent = 'Test d\'impression';
      }
    });
  }

  // Bouton ouvrir dossier logs
  if (elements.btnLogs) {
    elements.btnLogs.addEventListener('click', () => {
      console.log('[RENDERER] Click: Ouvrir dossier logs');
      window.cabflow.openLogsFolder();
    });
  }

  // Bouton afficher les logs dans l'app
  const btnShowLogs = document.getElementById('btn-show-logs');
  if (btnShowLogs) {
    btnShowLogs.addEventListener('click', () => {
      console.log('[RENDERER] Click: Afficher logs');
      loadAndShowLogs();
    });
  }

  // Bouton rafraichir logs
  const btnRefreshLogs = document.getElementById('btn-refresh-logs');
  if (btnRefreshLogs) {
    btnRefreshLogs.addEventListener('click', () => {
      console.log('[RENDERER] Click: Rafraichir logs');
      loadAndShowLogs();
    });
  }

  // Bouton copier logs
  const btnCopyLogs = document.getElementById('btn-copy-logs');
  if (btnCopyLogs) {
    btnCopyLogs.addEventListener('click', () => {
      const logsContent = document.getElementById('logs-content');
      navigator.clipboard.writeText(logsContent.textContent).then(() => {
        showToast('Logs copies dans le presse-papier', 'success');
      });
    });
  }

  // Bouton fermer logs
  const btnCloseLogs = document.getElementById('btn-close-logs');
  if (btnCloseLogs) {
    btnCloseLogs.addEventListener('click', () => {
      document.getElementById('logs-panel').style.display = 'none';
    });
  }

  // Bouton ouvrir site
  if (elements.btnOpenSite) {
    elements.btnOpenSite.addEventListener('click', async () => {
      console.log('[RENDERER] Click: Ouvrir site');
      const config = await window.cabflow.getConfig();
      window.open(config.siteUrl, '_blank');
    });
  }

  // Mode d'extraction (radio buttons)
  try {
    const modeRadios = document.querySelectorAll('input[name="extraction-mode"]');
    if (modeRadios.length && window.cabflow.getExtractionMode) {
      const current = await window.cabflow.getExtractionMode();
      console.log('[RENDERER] Mode extraction actuel:', current);
      modeRadios.forEach(r => {
        r.checked = (r.value === current);
        r.addEventListener('change', async (e) => {
          if (!e.target.checked) return;
          const res = await window.cabflow.setExtractionMode(e.target.value);
          if (res && res.success) {
            showToast('Mode change: ' + e.target.value, 'info');
          } else {
            showToast('Erreur changement mode: ' + (res && res.error), 'error');
          }
        });
      });
    }
  } catch (e) {
    console.error('[RENDERER] Erreur init mode extraction:', e);
  }

  console.log('[RENDERER] init() TERMINE - Tous les listeners attaches');
}

// Lancer l'initialisation
console.log('[RENDERER] Lancement init()...');
init();
