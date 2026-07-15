/**
 * PecExpress Desktop - Main Process
 * Application Electron pour capturer les impressions et les envoyer au cloud
 */

const { app, BrowserWindow, ipcMain, shell, Tray, Menu, Notification, nativeImage, session, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

// Modules internes
// Modules internes - Loaded later to avoid circular dependencies
// const { loadConfig, getConfig, startUpdateChecker, setOverride } = require('./config-manager');
// const { extractFromDevis, buildUrlWithParams } = require('./devis-extractor');

// ============================================
// Installation imprimante - Multi-plateforme
// ============================================

// Installation macOS via osascript avec administrator privileges
async function installPrinterMac() {
  const { exec } = require('child_process');
  const backendSrc = path.join(__dirname, '..', '..', 'resources', 'mac', 'cabflow-backend');
  const ppdSrc = path.join(__dirname, '..', '..', 'resources', 'mac', 'PECExpress_PEC.ppd');

  return new Promise((resolve, reject) => {
    log('Installation de l\'imprimante PecExpress (macOS)...');
    log('Backend source: ' + backendSrc);
    log('PPD source: ' + ppdSrc);

    const installScript = `
do shell script "
  mkdir -p /var/spool/cabflow
  chmod 777 /var/spool/cabflow
  cp '${backendSrc}' /usr/libexec/cups/backend/cabflow
  chown root:wheel /usr/libexec/cups/backend/cabflow
  chmod 700 /usr/libexec/cups/backend/cabflow
  cp '${ppdSrc}' /etc/cups/ppd/PECExpress_PEC.ppd
  chown root:_lp /etc/cups/ppd/PECExpress_PEC.ppd
  chmod 644 /etc/cups/ppd/PECExpress_PEC.ppd
  launchctl kickstart -k system/org.cups.cupsd 2>/dev/null || (launchctl stop org.cups.cupsd; sleep 1; launchctl start org.cups.cupsd)
  sleep 2
  lpadmin -x PECExpress_PEC 2>/dev/null || true
  lpadmin -p PECExpress_PEC -D 'Lancer la DPEC' -L 'PecExpress' -v 'cabflow:/' -P '/etc/cups/ppd/PECExpress_PEC.ppd' -o printer-is-shared=false -E
  echo OK
" with administrator privileges
`;

    exec(`osascript -e '${installScript.replace(/'/g, "'\"'\"'")}'`, (error, stdout, stderr) => {
      if (error) {
        log('Erreur installation macOS: ' + error.message);
        reject(error);
      } else {
        log('Imprimante Mon devis dentaire PEC installée avec succès (macOS)!');
        resolve(true);
      }
    });
  });
}

// Installation Windows — Approche directe sans fichier PS1 intermediaire
// Le script PS1 elevé ne s'executait pas (probleme d'escaping multi-couches)
// Nouvelle approche: ecrire le script dans C:\ProgramData\PecExpress\ (accessible par admin)
// et logguer dans le meme dossier
async function installPrinterWindows() {
  const { exec, execSync } = require('child_process');

  // Utiliser ProgramData (accessible par admin ET user) au lieu de %TEMP%
  const installDir = 'C:\\ProgramData\\PecExpress';
  const scriptPath = path.join(installDir, 'install.ps1');
  const logFile = path.join(installDir, 'install.log');
  const spoolDir = getSpoolPath();

  // Creer le dossier ProgramData\PecExpress si besoin
  if (!fs.existsSync(installDir)) {
    fs.mkdirSync(installDir, { recursive: true });
  }

  // Script PS1 MINIMAL et robuste — pas de mfilemon pour l'instant, juste creer l'imprimante
  const ps1Content = `
try {
    Start-Transcript -Path "${logFile.replace(/\\/g, '\\\\')}" -Force
} catch {}

Write-Output "=== INSTALL START ==="
Write-Output "User: $env:USERNAME"
Write-Output "Admin: $([bool](([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)))"

# Supprimer ancienne imprimante si elle existe
Write-Output "Suppression ancienne Mon devis dentaire PEC..."
Remove-Printer -Name "Mon devis dentaire PEC" -ErrorAction SilentlyContinue

# Creer le dossier spool
$spoolDir = "${spoolDir.replace(/\\/g, '\\\\')}"
if (-not (Test-Path $spoolDir)) {
    New-Item -ItemType Directory -Force -Path $spoolDir | Out-Null
}

# Donner les droits sur le spool systeme
$sysSpool = "$env:SystemRoot\\System32\\spool\\PRINTERS"
icacls $sysSpool /grant "$($env:USERNAME):(OI)(CI)RX" /T /Q 2>$null

# Port NUL:
$nulPort = Get-PrinterPort -Name "NUL:" -ErrorAction SilentlyContinue
if (-not $nulPort) {
    Add-PrinterPort -Name "NUL:" -ErrorAction SilentlyContinue
}

# Lister drivers disponibles
Write-Output "=== DRIVERS ==="
Get-PrinterDriver | Select-Object -ExpandProperty Name | ForEach-Object { Write-Output "  $_" }

# Driver GDI "Generic / Text Only" = produit EMFSPOOL avec EMR_EXTTEXTOUTW (texte Unicode)
# "Microsoft Print To PDF" produit du XPS (vectorise, pas de texte) = INUTILE
Write-Output "=== Installation driver Generic / Text Only ==="
try {
    pnputil /add-driver "$env:SystemRoot\\INF\\prnms009.inf" /install 2>$null
    Add-PrinterDriver -Name "Generic / Text Only" -ErrorAction SilentlyContinue
    Write-Output "Driver Generic / Text Only pret"
} catch {
    Write-Output "Note driver: $_"
}

Write-Output "=== Creation imprimante Mon devis dentaire PEC ==="
try {
    Add-Printer -Name "Mon devis dentaire PEC" -DriverName "Generic / Text Only" -PortName "NUL:" -ErrorAction Stop
    Set-Printer -Name "Mon devis dentaire PEC" -KeepPrintedJobs $true -ErrorAction SilentlyContinue
    Write-Output "SUCCES: Mon devis dentaire PEC cree (Generic / Text Only + NUL: + KeepPrintedJobs)"
} catch {
    Write-Output "ECHEC: $_"
}

# Verification
Write-Output "=== VERIFICATION ==="
$p = Get-Printer -Name "Mon devis dentaire PEC" -ErrorAction SilentlyContinue
if ($p) {
    Write-Output "OK: Name=$($p.Name) Driver=$($p.DriverName) Port=$($p.PortName)"
} else {
    Write-Output "ECHEC: Mon devis dentaire PEC NON TROUVEE"
    Write-Output "Imprimantes presentes:"
    Get-Printer | ForEach-Object { Write-Output "  $($_.Name)" }
}

Write-Output "=== INSTALL END ==="
try { Stop-Transcript } catch {}
`;

  return new Promise((resolve, reject) => {
    log('[INSTALL] === Debut installation imprimante ===');

    // Ecrire le script PS1 dans ProgramData (pas dans Temp)
    fs.writeFileSync(scriptPath, ps1Content, 'utf8');
    log('[INSTALL] Script ecrit: ' + scriptPath);

    // Supprimer ancien log
    if (fs.existsSync(logFile)) try { fs.unlinkSync(logFile); } catch(e) {}

    updateSetupProgress("Veuillez autoriser (OUI) si Windows le demande.");

    // Commande: lancer PowerShell eleve DIRECTEMENT (un seul prompt UAC, pas de PS intermediaire)
    // On passe le script en -File avec -ExecutionPolicy Bypass pour eviter le prompt ExecutionPolicy
    const escapedPath = scriptPath.replace(/'/g, "''");
    const psCommand = `powershell -NoProfile -WindowStyle Hidden -Command "Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File','${escapedPath}')"`;

    log('[INSTALL] Lancement elevation (UAC unique)...');

    exec(psCommand, { timeout: 120000 }, (error) => {
      // Lire et dumper le log d'installation
      log('[INSTALL] === LOG INSTALLATION ===');
      if (fs.existsSync(logFile)) {
        try {
          const installLog = fs.readFileSync(logFile, 'utf8');
          for (const line of installLog.split('\n')) {
            const l = line.trim();
            if (l && !l.startsWith('****')) log('[PS1] ' + l);
          }
        } catch (e) {
          log('[INSTALL] Erreur lecture log: ' + e.message);
        }
      } else {
        log('[INSTALL] LOG NON TROUVE: ' + logFile);
        // Verifier si le script existe toujours
        log('[INSTALL] Script existe: ' + fs.existsSync(scriptPath));
        log('[INSTALL] Dossier install existe: ' + fs.existsSync(installDir));
        try {
          const files = fs.readdirSync(installDir);
          log('[INSTALL] Contenu ' + installDir + ': ' + files.join(', '));
        } catch(e) { log('[INSTALL] Erreur listdir: ' + e.message); }
      }
      log('[INSTALL] === FIN LOG ===');

      // Verifier si l'imprimante existe
      let printerFound = false;
      try {
        const check = execSync('powershell -NoProfile -Command "Get-Printer -Name \'Mon devis dentaire PEC\' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name"', { encoding: 'utf8', timeout: 10000 });
        printerFound = check.trim().includes('Mon devis dentaire PEC');
      } catch (e) { }

      log('[INSTALL] Imprimante Mon devis dentaire PEC: ' + (printerFound ? 'INSTALLEE' : 'NON TROUVEE'));

      // Nettoyage script (garder le log pour debug)
      try { fs.unlinkSync(scriptPath); } catch(e) {}

      if (error) {
        log('[INSTALL] Erreur exec: ' + error.message);
        reject(error);
      } else if (!printerFound) {
        log('[INSTALL] ECHEC: imprimante non creee');
        reject(new Error('Imprimante Mon devis dentaire PEC non trouvee apres installation'));
      } else {
        log('[INSTALL] SUCCES !');
        resolve(true);
      }
    });
  });
}

// Fonction principale d'installation (détecte la plateforme)
async function installPrinterWithAdmin() {
  if (process.platform === 'darwin') {
    return installPrinterMac();
  } else if (process.platform === 'win32') {
    return installPrinterWindowsWithRetry();
  } else {
    throw new Error('Plateforme non supportée: ' + process.platform);
  }
}

// Wrapper pour installation Windows avec RETRY en cas d'échec
async function installPrinterWindowsWithRetry(retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      log(`Tentative installation imprimante ${i + 1}/${retries}...`);
      await installPrinterWindows();
      log('Installation réussie !');
      return true;
    } catch (e) {
      log(`Echec tentative ${i + 1}: ${e.message}`);
      if (i < retries - 1) {
        log('Délai avant nouvelle tentative (5s)...');
        await new Promise(resolve => setTimeout(resolve, 5000));
      } else {
        throw e;
      }
    }
  }
}

// Moved to setupIpcHandlers

// Verifier si l'imprimante existe (multi-plateforme)
function printerExists() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      // Methode 1: Registre HKCU
      try {
        const regCommand = 'reg query "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Devices" /v "Mon devis dentaire PEC"';
        execSync(regCommand, { stdio: 'ignore' });
        log('[CHECK] Imprimante trouvee via HKCU (Devices)');
        return true;
      } catch (e) {
        log('[CHECK] HKCU: non trouvee');
      }

      // Methode 2: Registre HKLM
      try {
        const regCommand2 = 'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Print\\Printers\\Mon devis dentaire PEC"';
        execSync(regCommand2, { stdio: 'ignore' });
        log('[CHECK] Imprimante trouvee via HKLM (Printers)');
        return true;
      } catch (e) {
        log('[CHECK] HKLM: non trouvee');
      }

      // Methode 3: wmic (fallback fiable pour Add-Printer)
      try {
        const wmicResult = execSync('wmic printer get name', { encoding: 'utf8', timeout: 5000 });
        const found = wmicResult.includes('Mon devis dentaire PEC');
        log('[CHECK] wmic printer list: ' + (found ? 'TROUVEE' : 'NON TROUVEE'));
        if (found) return true;
      } catch (e) {
        log('[CHECK] wmic erreur: ' + e.message);
      }

      log('[CHECK] Imprimante non trouvee (toutes methodes echouees)');
      return false;
    } else {
      const result = execSync('lpstat -p PECExpress_PEC 2>&1', { encoding: 'utf8' });
      const found = result.includes('PECExpress_PEC');
      log('[CHECK] lpstat: ' + (found ? 'TROUVEE' : 'NON TROUVEE'));
      return found;
    }
  } catch (e) {
    log('[CHECK] Erreur verification imprimante: ' + e.message);
    return false;
  }
}

// Variables globales
let mainWindow = null;
let loaderWindow = null;
let setupWindow = null;
let tray = null;
let isQuitting = false;
let watcher = null;

function createSetupWindow() {
  if (setupWindow) return;

  setupWindow = new BrowserWindow({
    width: 400,
    height: 450,
    show: false,
    frame: false, // Pas de bordure
    transparent: true, // Fond transparent
    resizable: false,
    alwaysOnTop: true, // Toujours au premier plan
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });

  setupWindow.loadFile(path.join(__dirname, '..', 'renderer', 'setup.html'));

  setupWindow.once('ready-to-show', () => {
    setupWindow.show();
    setupWindow.center();
  });

  setupWindow.on('closed', () => {
    setupWindow = null;
  });
}

function updateSetupProgress(message) {
  log('[SETUP UI] ' + message);
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.webContents.send('setup-progress', message);
  }
}

function closeSetupWindow() {
  if (setupWindow && !setupWindow.isDestroyed()) {
    setupWindow.close();
  }
}

/**
 * Créer la fenêtre de chargement (pré-créée au démarrage, cachée)
 * On ne la détruit jamais — show/hide uniquement pour affichage instantané.
 */
let _loaderSafetyTimer = null;
let _loaderBlurHandler = null;

function createLoaderWindow() {
  if (loaderWindow && !loaderWindow.isDestroyed()) return;

  loaderWindow = new BrowserWindow({
    width: 300,
    height: 400,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });

  loaderWindow.loadFile(path.join(__dirname, '..', 'renderer', 'loader.html'));

  loaderWindow.on('closed', () => {
    loaderWindow = null;
  });
}

function showLoader() {
  const t0 = Date.now();
  if (!loaderWindow || loaderWindow.isDestroyed()) createLoaderWindow();
  if (!loaderWindow) return;

  // Reset du contenu (remet le texte de base dans le HTML)
  try { loaderWindow.webContents.send('loader-reset'); } catch (e) {}

  // FORCER L'AFFICHAGE AU PREMIER PLAN, meme si Logos a le focus
  loaderWindow.setAlwaysOnTop(true, 'screen-saver'); // niveau le plus haut
  loaderWindow.center();
  loaderWindow.showInactive(); // Affiche SANS prendre le focus (evite que Logos refasse focus)
  // Puis amene vraiment au-dessus
  loaderWindow.moveTop();
  loaderWindow.focus();
  log('[LOADER] t=' + (Date.now() - t0) + 'ms shown (top-most, focused)');

  // Nettoyer l'ancien handler blur si déjà abonné
  if (_loaderBlurHandler) {
    try { loaderWindow.removeListener('blur', _loaderBlurHandler); } catch (e) {}
  }
  // Plus de hide sur blur: on attend que Chrome s'ouvre OU le safety timer
  _loaderBlurHandler = () => {
    log('[LOADER] blur ignore (loader reste visible jusqu\'a Chrome ou timeout)');
  };
  loaderWindow.once('blur', _loaderBlurHandler);

  // Filet de sécurité: force la fermeture après 15s (laisse le temps au pipeline PS)
  if (_loaderSafetyTimer) clearTimeout(_loaderSafetyTimer);
  _loaderSafetyTimer = setTimeout(() => {
    log('[LOADER] safety timer -> hide (15s)');
    hideLoader();
  }, 15000);
}

function updateLoaderPatient(data) {
  if (!loaderWindow || loaderWindow.isDestroyed()) return;
  try {
    loaderWindow.webContents.send('loader-patient-info', {
      nom: data.nom || '',
      prenom: data.prenom || '',
      devisId: data.devisId || '',
      actesCount: (data.actes || []).length
    });
    log('[LOADER] patient-info envoye: ' + (data.prenom || '') + ' ' + (data.nom || ''));
  } catch (e) {
    log('[LOADER] send patient-info echec: ' + e.message);
  }
}

function hideLoader() {
  if (_loaderSafetyTimer) { clearTimeout(_loaderSafetyTimer); _loaderSafetyTimer = null; }
  if (loaderWindow && !loaderWindow.isDestroyed()) {
    if (_loaderBlurHandler) {
      try { loaderWindow.removeListener('blur', _loaderBlurHandler); } catch (e) {}
      _loaderBlurHandler = null;
    }
    try { loaderWindow.hide(); } catch (e) {}
  }
}

// Configuration
const CONFIG = {
  siteUrl: 'https://app.mondevisdentaire.com',
  apiEndpoint: 'https://app.mondevisdentaire.com/api/desktop/process',
  printerName: 'Mon devis dentaire PEC'
};

// ============================================
// CABFLOW READER — Lecture directe Logos (< 100ms, sans impression)
// ============================================

// Deadline: jusqu'a ce timestamp, tout spool est skippe (CabFlowReader a deja ouvert Chrome)
// Expire automatiquement apres 10s pour permettre au pipeline XPS de reprendre en cas d'echec WMI
let _cabflowHandledUntil = 0;

/**
 * Trouve le chemin de CabFlowReader.exe dans les emplacements connus
 */
function findCabFlowReader() {
  const candidates = [
    // extraResources packagé (production portable) — process.resourcesPath/resources/win/
    path.join(process.resourcesPath || '', 'resources', 'win', 'CabFlowReader.exe'),
    // extraResources via execPath (production)
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', 'CabFlowReader.exe'),
    // Ressources directes (production alternative)
    path.join(path.dirname(process.execPath), 'resources', 'win', 'CabFlowReader.exe'),
    // Ressources en mode dev (electron dev)
    path.join(__dirname, '..', '..', 'resources', 'win', 'CabFlowReader.exe'),
    // ProgramData (installation stable)
    'C:\\ProgramData\\PecExpress\\CabFlowReader.exe',
    // AppData Local
    path.join(os.homedir(), 'AppData', 'Local', 'PecExpress', 'CabFlowReader.exe'),
    // Desktop (fallback dev)
    path.join(os.homedir(), 'Desktop', 'CabFlowReader.exe'),
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

/**
 * Ouvre une URL dans Chrome (ou navigateur par défaut)
 */
function openUrlInBrowser(url) {
  if (process.platform === 'win32') {
    const { execSync } = require('child_process');
    let chromePath = null;
    try {
      const reg = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: 'utf8', timeout: 3000 }
      );
      const m = reg.match(/REG_SZ\s+(.+)/);
      if (m && m[1] && fs.existsSync(m[1].trim())) chromePath = m[1].trim();
    } catch (e) {}
    if (!chromePath) {
      try {
        const reg2 = execSync(
          'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
          { encoding: 'utf8', timeout: 3000 }
        );
        const m2 = reg2.match(/REG_SZ\s+(.+)/);
        if (m2 && m2[1] && fs.existsSync(m2[1].trim())) chromePath = m2[1].trim();
      } catch (e) {}
    }
    if (chromePath) {
      const { spawn } = require('child_process');
      const child = spawn(chromePath, [url], { detached: true, stdio: 'ignore' });
      child.unref();
    } else {
      shell.openExternal(url);
    }
    // Force Chrome au premier plan apres ouverture (sinon il peut rester en arriere-plan
    // car Logos garde le focus). On utilise un script PowerShell qui:
    //   1. Trouve un process chrome.exe avec une MainWindowHandle
    //   2. Le restaure si minimise + SetForegroundWindow
    forceBrowserForeground();
  } else {
    const { exec } = require('child_process');
    exec(`open -a "Google Chrome" "${url}"`, (err) => { if (err) shell.openExternal(url); });
  }
}

// Force Chrome au premier plan (Windows). Appelle un script .ps1 dedie pour
// eviter les enfers de quoting via exec inline.
function forceBrowserForeground() {
  if (process.platform !== 'win32') return;
  // Cherche foreground-chrome.ps1 dans les paths possibles (dev + installe)
  const candidates = [
    path.join(process.resourcesPath || '', 'resources', 'win', 'foreground-chrome.ps1'),
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', 'foreground-chrome.ps1'),
    path.join(__dirname, '..', '..', 'resources', 'win', 'foreground-chrome.ps1'),
  ];
  let psScript = null;
  for (const p of candidates) {
    try { if (fs.existsSync(p)) { psScript = p; break; } } catch (e) {}
  }
  if (!psScript) {
    log('[FOREGROUND] foreground-chrome.ps1 introuvable');
    return;
  }
  const { exec } = require('child_process');
  exec(`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${psScript}"`,
       { windowsHide: true, timeout: 8000 },
       (err, stdout) => {
         if (err) log('[FOREGROUND] Echec foreground Chrome: ' + err.message);
         else log('[FOREGROUND] ' + (stdout || '').trim());
       });
}

/**
 * Construit l'URL Mon devis dentaire depuis les données CabFlowReader JSON
 */
function buildCabFlowUrl(data) {
  const base = 'https://app.mondevisdentaire.com/prises-en-charge/nouvelle';
  const actes = (data.actes || []).map(a => ({
    code_ccam: a.ccam || '',
    nature_acte: a.nom || '',
    montant: String(a.honoraires != null ? a.honoraires : 0),
    numero_dent: (a.dent || '').replace(/\s+/g, ','),
    panier: '',
    materiau: ''
  }));
  const prat = data.praticienInfo || {};
  const mut = data.mutuelle || {};
  const params = new URLSearchParams({
    source: 'cabflow-desktop',
    nom: data.nom || '',
    prenom: data.prenom || '',
    date_naissance: data.dateNaissance || '',
    nir: data.nir || '',
    email: data.email || '',
    praticien_nom: prat.nom || '',
    praticien_prenom: prat.prenom || '',
    praticien_rpps: prat.rpps || '',
    praticien_adeli: prat.adeli || '',
    mutuelle_nom: mut.nom || '',
    mutuelle_numero_amc: mut.numeroAMC || '',
    mutuelle_numero_adherent: mut.numeroAdherent || '',
    mutuelle_numero_contrat: mut.numeroContrat || '',
    actes: JSON.stringify(actes)
  });
  return base + '?' + params.toString();
}

/**
 * Lit le devis courant via CabFlowReader.exe et ouvre Mon devis dentaire dans Chrome
 * @param {string} docName - Nom du document depuis WMI (peut contenir l'ID du devis)
 * @returns {Promise<boolean>} true si Chrome a ete ouvert avec succes
 */
async function readAndOpenCabFlow(docName) {
  const T0 = Date.now();
  const cabflowPath = findCabFlowReader();
  if (!cabflowPath) {
    log('[CABFLOW] CabFlowReader.exe non trouve');
    return false;
  }
  log('[CABFLOW] Utilise: ' + cabflowPath);

  // Tenter d'extraire un devisId depuis le nom du document
  const args = [];
  const devisMatch = (docName || '').match(/\b(\d{3,6})\b/);
  if (devisMatch) {
    log('[CABFLOW] DevisId detecte dans docName "' + docName + '": ' + devisMatch[1]);
    args.push('0', devisMatch[1]); // arg1=patientId(auto), arg2=devisId
  }

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let stdout = '';
    let stderr = '';

    // Capture aussi stderr pour extraire patientsDir + memoOffset utilises par CabFlowReader
    let mmoCtx = { patientsDir: null, memoOffset: null, patientId: null, devisId: null };
    const proc = spawn(cabflowPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) log('[CABFLOW] ' + msg);
      stderr += msg;
      // Parse les lignes "Patient=X Dir=Y" et "MemoOff=0xXXXX" / "Devis selectionne: X"
      const mDir = msg.match(/Patient=(\d+)\s+Dir=(.+)/);
      if (mDir) { mmoCtx.patientId = parseInt(mDir[1], 10); mmoCtx.patientsDir = mDir[2].trim(); }
      const mSel = msg.match(/Devis selectionne:\s*(\d+)\s+date=\d+\s+memoOff=0x([0-9A-Fa-f]+)/);
      if (mSel) { mmoCtx.devisId = parseInt(mSel[1], 10); mmoCtx.memoOffset = parseInt(mSel[2], 16); }
    });

    const timeout = setTimeout(() => {
      proc.kill();
      log('[CABFLOW] TIMEOUT 5s');
      resolve(false);
    }, 5000);

    proc.on('close', async (code) => {
      clearTimeout(timeout);
      const elapsed = Date.now() - T0;
      log('[CABFLOW] Termine en ' + elapsed + 'ms (code=' + code + ')');

      if (code !== 0 || !stdout.trim()) {
        log('[CABFLOW] Echec (code=' + code + '): ' + (stderr.split('\n')[0] || ''));
        resolve(false);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        log('[CABFLOW] Patient: ' + data.nom + ' ' + data.prenom +
            ' | Devis: ' + data.devisId + ' | ' + (data.actes || []).length + ' actes' +
            ' | NIR: ' + (data.nir || 'ABSENT'));

        // === RE-PARSE PROPRE via notre parseur MMO Node.js ===
        // CabFlowReader.exe a un bug: il ne strip pas les 12 bytes de header
        // toutes les 128 bytes du fichier DEVIS.MMO -> libelles pollues + actes manquants
        // Notre parseur reconstruit le XML proprement et lit TOUS les actes
        if (mmoCtx.patientsDir && mmoCtx.memoOffset != null) {
          try {
            const mmoParser = require('./logos-mmo-parser');
            mmoParser.setLogger(log);
            const parsed = mmoParser.readPatientDevisClean({
              patientsDir: mmoCtx.patientsDir,
              patientId: mmoCtx.patientId,
              devisId: mmoCtx.devisId,
              memoOffset: mmoCtx.memoOffset
            });
            const civilInfo = { nom: data.nom, prenom: data.prenom,
                                dateNaissance: data.dateNaissance, nir: data.nir };
            const clean = mmoParser.toPecExpressFormat(parsed, civilInfo);
            log('[CABFLOW] CLEAN parsing OK: ' + clean.actes.length + ' actes (vs ' +
                (data.actes || []).length + ' bruts CabFlowReader), praticien=' + clean.praticien +
                ', honTotal=' + clean.honorairesTotal);

            // CROSS-CHECK: compare total UI (ce que voit l'utilisateur) vs total BDD
            const uiCtx = global._cabflowUiContext;
            if (uiCtx && uiCtx.honoraires > 0) {
                const diff = Math.abs(clean.honorairesTotal - uiCtx.honoraires);
                if (diff > 0.5) {  // tolere 50 centimes d'arrondi
                    log('[CABFLOW] MISMATCH UI=' + uiCtx.honoraires + '€ vs BDD=' +
                        clean.honorairesTotal + '€ (diff=' + diff.toFixed(2) +
                        '€) -> BDD pas a jour, on garde quand meme la BDD (devis non sauvegarde)');
                    clean._uiMismatch = { uiTotal: uiCtx.honoraires, bddTotal: clean.honorairesTotal, diff };
                } else {
                    log('[CABFLOW] UI/BDD MATCH (' + uiCtx.honoraires + '€) -> devis bien sauvegarde');
                }
            }

            // Override le data avec la version clean
            Object.assign(data, clean);
          } catch (eMmo) {
            log('[CABFLOW] WARN: re-parse MMO clean failed: ' + eMmo.message +
                ' - on garde le resultat CabFlowReader brut');
          }
        } else {
          log('[CABFLOW] Contexte MMO absent (patientsDir/memoOffset), skip re-parse clean');
        }

        if (!data.nir) {
          log('[CABFLOW] WARN: NIR absent, URL sera incomplete');
        }

        // === LECTURE MUTUELLE (CIVILORG.MMO) ===
        // Recupere la mutuelle AMC du patient. Match en cascade: NIR si dispo, sinon
        // (nom + prenom + dateNaissance). Robuste meme quand le NIR n'est pas stocke
        // dans l'entree Couvertures du patient (cas observe sur certains patients).
        if (mmoCtx.patientsDir) {
          try {
            const civilorgParser = require('./logos-civilorg-parser');
            civilorgParser.setLogger(log);
            const civilorgPath = require('path').join(mmoCtx.patientsDir, 'CIVILORG.MMO');
            const mutuelle = civilorgParser.findMutuelle(civilorgPath, {
              nir: data.nir,
              nom: data.nom,
              prenom: data.prenom,
              dateNaissance: data.dateNaissance
            });
            if (mutuelle) {
              data.mutuelle = mutuelle;
              log('[CABFLOW] Mutuelle: ' + mutuelle.nom + ' AMC=' + mutuelle.numeroAMC +
                  ' adh=' + mutuelle.numeroAdherent + ' contrat=' + mutuelle.numeroContrat);
            } else {
              log('[CABFLOW] Pas de mutuelle trouvee pour ce patient');
            }
          } catch (eMut) {
            log('[CABFLOW] Erreur lecture mutuelle (non bloquant): ' + eMut.message);
          }
        }

        // === EMAIL patient : lecture directe de CIVIL.FIC (fiche patient) ===
        // Robuste : marche dossier ouvert OU fermé. Enregistrement N = patient N
        // (2504 octets/rec, email a l'offset +355). Repli: scan memoire.
        try {
          const civilReader = require('./logos-civil-reader');
          civilReader.setLogger(log);
          let civ = null;
          if (mmoCtx.patientsDir && mmoCtx.patientId) {
            civ = civilReader.readPatientCivil(mmoCtx.patientsDir, mmoCtx.patientId, {
              expectedNom: data.nom, expectedPrenom: data.prenom,
            });
          }
          if (civ && civ.email) {
            data.email = civ.email;
            if (!data.portable && civ.portable) data.portable = civ.portable;
            log('[CABFLOW] Email patient (CIVIL.FIC): ' + civ.email);
          } else {
            const memReader = require('./logos-memory-reader');
            const email = await memReader.readPatientEmail({ nom: data.nom, nir: data.nir });
            if (email) { data.email = email; log('[CABFLOW] Email patient (RAM fallback): ' + email); }
            else { log('[CABFLOW] Email patient introuvable'); }
          }
        } catch (eMail) {
          log('[CABFLOW] Erreur lecture email (non bloquant): ' + eMail.message);
        }

        // Pousse le nom patient + nb actes dans le loader (visible immediatement)
        updateLoaderPatient(data);

        const url = buildCabFlowUrl(data);
        log('[CABFLOW] URL: ' + url.substring(0, 120) + '...');
        openUrlInBrowser(url);
        resolve(true);
      } catch (e) {
        log('[CABFLOW] JSON parse error: ' + e.message);
        log('[CABFLOW] Stdout brut: ' + stdout.substring(0, 200));
        resolve(false);
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      log('[CABFLOW] Spawn error: ' + e.message);
      resolve(false);
    });
  });
}

// Chemins (multi-plateforme)
// macOS: /var/spool/cabflow/ (CUPS backend)
// Windows: C:\ProgramData\PecExpress\spool\ (mfilemon - accessible par SYSTEM et User)
const getSpoolPath = () => {
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\PecExpress\\spool';
  }
  return '/var/spool/cabflow';
};
const getLogsPath = () => path.join(os.homedir(), 'PecExpress', 'logs');

/**
 * Assurer que les dossiers existent
 * macOS: Le spool /var/spool/cabflow/ est créé par l'installateur avec privilèges admin
 * Windows: Le spool %LOCALAPPDATA%\PecExpress\spool\ peut être créé sans admin
 */
function ensureDirectories() {
  const logsDir = getLogsPath();
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  // Sur Windows, créer le dossier spool (pas besoin d'admin)
  if (process.platform === 'win32') {
    const spoolDir = getSpoolPath();
    if (!fs.existsSync(spoolDir)) {
      fs.mkdirSync(spoolDir, { recursive: true });
    }
  }
}

/**
 * Logger
 */
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;

  // Protection contre EPIPE (console détachée)
  try {
    console.log(logMessage);
  } catch (e) {
    // Console inaccessible, on ignore
  }

  try {
    const logFile = path.join(getLogsPath(), 'app.log');
    fs.appendFileSync(logFile, logMessage + '\n');
  } catch (e) {
    // Silently fail for file write errors too
  }
}

// ============================================================================
// WEBSOCKET SERVER (Port 8082)
// ============================================================================
let wss = null;

function startWebSocketServer() {
  try {
    wss = new WebSocket.Server({ port: 8082 });
    log('WebSocket Server démarré sur port 8082');

    wss.on('connection', (ws) => {
      log('Nouveau client WebSocket connecté');
      ws.send(JSON.stringify({ type: 'connected', message: 'PecExpress Desktop Connected' }));

      ws.on('message', (message) => {
        log('Message reçu du client WS: ' + message);
      });

      ws.on('error', (e) => log('Erreur client WS: ' + e.message));
    });

    wss.on('error', (error) => {
      log('Erreur WebSocket Server: ' + error.message);
    });
  } catch (e) {
    log('Impossible de démarrer le serveur WebSocket: ' + e.message);
  }
}

// Ecoute le pipe nomme \\.\pipe\cabflow-logos
// La DLL injectee dans LOGOS_w.exe ecrit dedans quand l'utilisateur clique
// le bouton Mon devis dentaire (apres avoir auto-sauvegarde le devis dans Logos).
// Format des messages: une ligne JSON par message
//   {"type":"open-pec","patient":"BLUM Denis"}
let cabflowPipeServer = null;
function startPecExpressPipeListener() {
  try {
    const net = require('net');
    const PIPE_PATH = '\\\\.\\pipe\\cabflow-logos';
    cabflowPipeServer = net.createServer((conn) => {
      let buf = '';
      conn.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          log('[PIPE] Message recu: ' + line);
          let msg;
          try { msg = JSON.parse(line); }
          catch (e) { log('[PIPE] JSON invalide: ' + e.message); continue; }
          if (msg.type === 'open-pec') {
            log('[PIPE] -> open-pec patient="' + (msg.patient || '') +
                '" uiTotal=' + (msg.uiHonoraires || 0) +
                ' uiDate=' + (msg.uiDateDevis || ''));
            // Stocke le contexte UI pour cross-check dans readAndOpenCabFlow
            global._cabflowUiContext = {
              honoraires: msg.uiHonoraires || 0,
              reste: msg.uiReste || 0,
              amo: msg.uiAmo || 0,
              dateDevis: msg.uiDateDevis || '',
              validite: msg.uiValidite || ''
            };
            readAndOpenCabFlow(null).then(success => {
              log('[PIPE] CabFlowReader: ' + (success ? 'OK Chrome ouvert' : 'ECHEC'));
              global._cabflowUiContext = null;
            }).catch(err => log('[PIPE] Erreur CabFlowReader: ' + err.message));
          }
        }
      });
      conn.on('error', (e) => log('[PIPE] Erreur connexion: ' + e.message));
    });
    cabflowPipeServer.on('error', (e) => log('[PIPE] Erreur server: ' + e.message));
    cabflowPipeServer.listen(PIPE_PATH, () => {
      log('[PIPE] Listener actif sur ' + PIPE_PATH);
    });
  } catch (e) {
    log('[PIPE] Impossible de demarrer pipe listener: ' + e.message);
  }
}

function broadcastToWebClients(data) {
  if (!wss) return;

  const payload = JSON.stringify({
    type: 'devis_extracted',
    data: data
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
  log('Données envoyées aux clients WebSocket');
}


/**
 * Creer la fenetre principale
 */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 750,
    show: false,
    title: 'Mon devis dentaire Connecté v' + app.getVersion(),
    resizable: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js'),
      // FORCER: pas de cache
      cache: false
    }
  });

  // DESACTIVER LE CACHE COMPLETEMENT
  mainWindow.webContents.session.clearCache().then(() => {
    log('[CACHE] Cache Chromium vide avec succes');
  });
  mainWindow.webContents.session.clearStorageData({
    storages: ['cachestorage', 'shadercache', 'serviceworkers']
  }).then(() => {
    log('[CACHE] StorageData nettoye');
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Masquer au lieu de fermer
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/**
 * Afficher la fenetre des parametres
 */
function showSettings() {
  if (!mainWindow) {
    createWindow();
  }
  mainWindow.show();
  mainWindow.focus();
}

/**
 * Creer l'icone systray
 */
function createTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');

  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
    icon = icon.resize({ width: 16, height: 16 });
  } else {
    // Creer une icone vide si le fichier n'existe pas
    icon = nativeImage.createEmpty();
  }

  tray = new Tray(icon);
  tray.setToolTip('Mon devis dentaire Connecté');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mon devis dentaire Connecté', enabled: false },
    { type: 'separator' },
    {
      label: 'Ouvrir Mon devis dentaire',
      click: () => shell.openExternal(CONFIG.siteUrl)
    },
    {
      label: 'Tableau de bord',
      click: openDashboard
    },
    { type: 'separator' },
    {
      label: 'Lire devis Logos maintenant',
      click: () => {
        showLoader();
        readAndOpenCabFlow(null).then(success => {
          if (success) {
            _cabflowHandledUntil = Date.now() + 10000;
            // Loader se ferme via blur ou safety timer
          } else {
            hideLoader();
            log('[TRAY] CabFlowReader echec ou aucun patient actif');
          }
        }).catch(err => {
          hideLoader();
          log('[TRAY] exception: ' + err.message);
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        // Fermeture manuelle : on ecrit le flag pour empecher le watchdog
        // de relancer. Le flag sera efface au prochain demarrage Windows.
        try {
          const autoFeatures = require('./auto-features');
          autoFeatures.setManualQuitFlag();
        } catch (e) {}
        isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', openDashboard);
  tray.on('click', openDashboard);
}

// Wrapper pour ouvrir la fenetre dashboard (lazy)
function openDashboard() {
  try {
    const dashboard = require('./dashboard');
    dashboard.show();
  } catch (e) {
    log('[TRAY] Erreur ouverture dashboard: ' + e.message);
    // Fallback: ancien comportement
    showSettings();
  }
}

/**
 * Demarrer la surveillance du dossier spool
 */
function startWatcher() {
  const spoolPath = getSpoolPath();
  log('Surveillance du dossier: ' + spoolPath);

  // S'assurer que le dossier existe
  if (!fs.existsSync(spoolPath)) {
    log('Dossier spool non trouvé, création...');
    try {
      fs.mkdirSync(spoolPath, { recursive: true });
    } catch (e) {
      log('Impossible de créer le dossier spool: ' + e.message);
      return;
    }
  }

  try {
    const processingFiles = new Set();

    watcher = fs.watch(spoolPath, async (eventType, filename) => {
      if (!filename || filename.startsWith('.')) return;

      // Sur Windows, ne traiter que les .pdf
      if (process.platform === 'win32' && !filename.toLowerCase().endsWith('.pdf')) return;

      // Debounce: Ignorer si déjà en cours de traitement
      if (processingFiles.has(filename)) return;

      const filePath = path.join(spoolPath, filename);

      // AFFICHER LE LOADER IMMEDIATEMENT
      showLoader();
      log('Nouveau fichier detecte (debut): ' + filename);

      // Marquer comme en cours
      processingFiles.add(filename);

      // Attendre que le fichier soit completement ecrit
      // Augmenté à 1000ms pour être sûr que le driver a fini d'écrire
      await new Promise(resolve => setTimeout(resolve, 1000));

      if (!fs.existsSync(filePath)) {
        processingFiles.delete(filename);
        hideLoader(); // Cacher si le fichier disparaît
        return;
      }

      log('Fichier prêt pour traitement: ' + filename);

      try {
        await processFile(filePath);
      } catch (e) {
        hideLoader();
      } finally {
        // Nettoyage après délai pour éviter rebonds "modify" tardifs
        setTimeout(() => {
          processingFiles.delete(filename);
        }, 2000);
      }
    });
  } catch (error) {
    log('Erreur surveillance: ' + error.message);
  }
}

// ============================================
// EMFSPOOL: Traitement des fichiers spool Windows
// Quand le spool-parser capture un EMFSPOOL, on extrait le texte
// et on l'envoie a l'API
// ============================================

/**
 * Traite un buffer EMFSPOOL capture par le spool-parser
 * Extrait le texte via EMR_EXTTEXTOUTW et l'envoie a l'API
 */
async function processEmfSpool(captured) {
  const { parseEmfSpoolBuffer } = require('./emfspool-parser');
  const fetch = require('node-fetch');

  // Si CabFlowReader a deja ouvert Chrome pour ce job, on skip le spool (fenetre 10s)
  if (Date.now() < _cabflowHandledUntil) {
    log('[EMFSPOOL] Skip — deja traite par CabFlowReader');
    return;
  }

  try {
    log('=== TRAITEMENT EMFSPOOL ===');
    log(`[EMFSPOOL] Fichier: ${captured.name} (${(captured.size / 1024).toFixed(1)} KB)`);

    showLoader();

    const extractStart = Date.now();
    const extractedData = parseEmfSpoolBuffer(captured.buffer);
    const extractDuration = Date.now() - extractStart;

    if (!extractedData || extractedData.pages.every(p => p.elements.length === 0)) {
      log('[EMFSPOOL] Aucun texte extrait, abandon');
      hideLoader();
      return;
    }

    const totalElements = extractedData.pages.reduce((s, p) => s + p.elements.length, 0);
    log(`[EMFSPOOL] Extraction en ${extractDuration}ms: ${extractedData.pages.length} pages, ${totalElements} elements`);
    if (extractedData.docName) {
      log(`[EMFSPOOL] Document: ${extractedData.docName}`);
    }

    // Log des premiers elements pour verification
    const preview = extractedData.pages[0]?.elements.slice(0, 5) || [];
    for (const elem of preview) {
      log(`[EMFSPOOL] Preview: "${elem.text}" @ (${elem.x}, ${elem.y})`);
    }

    // Envoyer a l'API (meme format que le pipeline PDF)
    const jsonPayload = JSON.stringify({ pages: extractedData.pages });
    const jsonSize = Buffer.byteLength(jsonPayload);
    log(`[EMFSPOOL] Envoi JSON (${(jsonSize / 1024).toFixed(1)} KB)...`);

    const uploadStart = Date.now();
    const response = await fetch('https://app.mondevisdentaire.com/api/desktop/process-pdf', {
      method: 'POST',
      body: jsonPayload,
      headers: { 'Content-Type': 'application/json' }
    });
    const uploadDuration = Date.now() - uploadStart;

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const result = await response.json();
    log(`[EMFSPOOL] Reponse en ${uploadDuration}ms (total: ${extractDuration + uploadDuration}ms)`);

    hideLoader();

    // Ouvrir le navigateur si URL de redirection
    if (result && result.success && result.redirect_url) {
      log('[EMFSPOOL] URL de redirection: ' + result.redirect_url);
      const url = result.redirect_url;

      if (process.platform === 'win32') {
        const { exec, execSync } = require('child_process');
        // Chercher Chrome
        let chromePath = null;
        try {
          const regResult = execSync(
            'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
            { encoding: 'utf8', timeout: 5000 }
          );
          const regMatch = regResult.match(/REG_SZ\s+(.+)/);
          if (regMatch && regMatch[1] && fs.existsSync(regMatch[1].trim())) {
            chromePath = regMatch[1].trim();
          }
        } catch (e) { /* fallback */ }

        if (chromePath) {
          exec(`"${chromePath}" "${url}"`);
        } else {
          shell.openExternal(url);
        }
      } else {
        const { exec } = require('child_process');
        exec(`open -a "Google Chrome" "${url}"`, (error) => {
          if (error) shell.openExternal(url);
        });
      }

      // Broadcast WebSocket
      broadcastToWebClients(result);
    }

    log('=== FIN TRAITEMENT EMFSPOOL ===');
  } catch (e) {
    log('[EMFSPOOL] ERREUR: ' + e.message);
    hideLoader();
  }

  // Nettoyage: supprimer les vieux SPL du dossier spool systeme (> 5 min)
  try {
    const spoolDir = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'spool', 'PRINTERS');
    const files = fs.readdirSync(spoolDir);
    const now = Date.now();
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.spl') && !f.toLowerCase().endsWith('.shd')) continue;
      try {
        const fullPath = path.join(spoolDir, f);
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > 5 * 60 * 1000) {
          fs.unlinkSync(fullPath);
          log('[EMFSPOOL] Cleanup vieux spool: ' + f);
        }
      } catch (e) { /* ignore - fichier peut etre verrouille */ }
    }
  } catch (e) { /* ignore */ }
}

/**
 * Handler appele au CLIC sur le bouton overlay "Lancer la PEC".
 * Lit le devis live en RAM Logos + construit URL Mon devis dentaire + ouvre Chrome.
 *
 * @param {{devisId, patient, devisHwnd, patientHwnd}} info
 */
async function handleLancerPec(info) {
  const T0 = Date.now();
  log(`[PEC] Devis ${info.devisId} | ${info.patient}`);
  showLoader();

  try {
    const { readCurrentDevis } = require('./logos-memory-reader');
    const devisLive = await readCurrentDevis();
    if (!devisLive.success) {
      log(`[PEC] Lecture memoire echec: ${devisLive.error}`);
      hideLoader();
      // Fallback CabFlowReader (BDD - mais devis pas enregistre = potentiellement vieux)
      log(`[PEC] Fallback CabFlowReader pour devis ${info.devisId}`);
      const ok = await readAndOpenCabFlow(info.devisId);
      return { success: ok };
    }

    log(`[PEC] Memoire OK: ${devisLive.actes.length} actes | totaux ${JSON.stringify(devisLive.devis.totaux)}`);
    updateLoaderPatient({
      nom: devisLive.patient.nom,
      prenom: devisLive.patient.prenom,
      devisId: info.devisId,
      actes: devisLive.actes
    });

    // Construire URL Mon devis dentaire format compatible avec ce qui existe
    const actes = devisLive.actes.map(a => ({
      code_ccam: a.code_ccam || '',
      nature_acte: a.nature_acte || '',
      montant: String(a.montant || '0'),
      numero_dent: a.numero_dent || '',
      panier: '',
      materiau: a.materiaux || ''
    }));

    const params = new URLSearchParams({
      source: 'cabflow-desktop-overlay',
      nom: devisLive.patient.nom,
      prenom: devisLive.patient.prenom,
      date_naissance: devisLive.patient.dateNaissance || '',
      nir: devisLive.patient.nir || '',
      actes: JSON.stringify(actes)
    });
    const url = 'https://app.mondevisdentaire.com/prises-en-charge/nouvelle?' + params.toString();

    log(`[PEC] URL: ${url.substring(0, 150)}...`);
    openUrlInBrowser(url);
    log(`[PEC] === FIN PEC en ${Date.now() - T0}ms ===`);
    return { success: true, devisId: info.devisId };
  } catch (e) {
    log('[PEC] Erreur: ' + e.message);
    hideLoader();
    return { success: false, error: e.message };
  }
}

// Timestamp du dernier job d'impression recu par WMI (true t=0)
let _lastPrintJobTime = null;
let _wmiProcess = null;
// Dernier docName WMI (utilise pour fallback CabFlowReader si extraction PDF echoue)
let _lastDocName = null;

/**
 * Routeur unifie pour un SPL capture: route vers PS/XPS/EMF selon le format
 * et le mode d'extraction configure. En mode 'auto', si l'extraction PDF echoue,
 * tente le fallback Logos via CabFlowReader.
 */
async function handleCapturedSpool(captured) {
  // Skip si CabFlowReader a deja traite ce job (mode logos)
  if (Date.now() < _cabflowHandledUntil) {
    log(`[ROUTER] Skip ${captured.format} — deja traite par CabFlowReader`);
    return;
  }

  let mode = 'auto';
  try {
    const { getConfig } = require('./config-manager');
    const cfg = getConfig();
    if (cfg && cfg.extractionMode) mode = cfg.extractionMode;
  } catch (e) {}

  log(`[ROUTER] Format=${captured.format} mode=${mode}`);

  // Format PostScript: pipeline PDF primaire
  if (captured.format === 'postscript') {
    const result = await processPostScriptSpool(captured);
    if (result && result.success) {
      _cabflowHandledUntil = Date.now() + 10000;
      return;
    }
    // Echec extraction PDF -> fallback Logos en mode auto
    if (mode === 'auto') {
      log('[ROUTER] Echec PDF, fallback CabFlowReader (Logos)...');
      showLoader();
      const ok = await readAndOpenCabFlow(_lastDocName || '');
      if (ok) {
        _cabflowHandledUntil = Date.now() + 10000;
      } else {
        hideLoader();
        log('[ROUTER] CabFlowReader echec aussi, abandon');
      }
    }
    return;
  }

  // Format XPS/EMF: pipelines legacy
  // En mode 'auto' ou 'pdf', on ignore les XPS car le PS arrivera (meme job).
  // Le XPS est cree par Windows en parallele du PS, on attend le PS.
  if (captured.format === 'xps' || captured.format === 'emfspool') {
    if (mode === 'pdf') {
      log(`[ROUTER] ${captured.format} ignore en mode PDF (attente PS)`);
      return;
    }
    if (mode === 'auto') {
      // Decision: ne pas declencher tout de suite pour laisser le PS arriver.
      // Si pas de PS dans 4s, alors le XPS prend la main.
      log(`[ROUTER] ${captured.format} mis en attente 4s (mode auto, attend PS)`);
      const xpsBackup = captured;
      setTimeout(async () => {
        if (Date.now() < _cabflowHandledUntil) {
          log(`[ROUTER] PS deja traite, XPS ignore`);
          return;
        }
        log(`[ROUTER] Pas de PS recu, fallback ${xpsBackup.format} legacy`);
        if (xpsBackup.format === 'xps') await processXpsSpool(xpsBackup);
        else await processEmfSpool(xpsBackup);
      }, 4000);
      return;
    }
    // mode 'logos': passer au pipeline legacy direct
    if (captured.format === 'xps') await processXpsSpool(captured);
    else await processEmfSpool(captured);
    return;
  }
}

/**
 * Demarre un moniteur WMI qui log l'instant exact ou Windows recoit le job d'impression
 * (AVANT que le fichier SPL soit cree) — donne le vrai t=0 cote utilisateur
 */
/**
 * Hook clavier global Ctrl+P : affiche le loader INSTANTANEMENT et re-injecte
 * Ctrl+P dans la fenetre Logos active pour declencher l'impression.
 *
 * Latence: ~20ms entre touche pressee et loader visible.
 */
let _ctrlPLastTrigger = 0;
let _ctrlPRegistered = false;

function _ctrlPHandler() {
  const T0 = Date.now();

  // Debounce: ignore si declenchement < 500ms (anti-double)
  if (T0 - _ctrlPLastTrigger < 500) {
    log('[CTRL+P] Debounce: ignore (dernier=' + (T0 - _ctrlPLastTrigger) + 'ms)');
    return;
  }
  _ctrlPLastTrigger = T0;

  log('[CTRL+P] *** Ctrl+P DETECTE *** affichage loader instantane');

  // 1. Afficher le loader IMMEDIATEMENT
  showLoader();
  log('[CTRL+P] Loader affiche en ' + (Date.now() - T0) + 'ms');

  // 2. Re-injecter Ctrl+P dans la fenetre active (Logos) en desenregistrant
  //    temporairement le hook, simulant Ctrl+P, puis reactivant le hook.
  try {
    globalShortcut.unregister('CommandOrControl+P');

    // Envoyer Ctrl+P via PowerShell SendKeys (rapide, natif Windows)
    const { spawn } = require('child_process');
    const sendKeysScript = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait('^p')`;
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', sendKeysScript], {
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
      windowsHide: true
    });
    proc.unref();
    log('[CTRL+P] Ctrl+P reinjecte vers Logos en ' + (Date.now() - T0) + 'ms');

    // Reactiver le hook apres 600ms (le temps que Logos consomme le Ctrl+P)
    setTimeout(() => {
      try { globalShortcut.register('CommandOrControl+P', _ctrlPHandler); } catch (e) {}
    }, 600);
  } catch (e) {
    log('[CTRL+P] Erreur reinjection: ' + e.message);
  }
}

function setupCtrlPHook() {
  if (_ctrlPRegistered) return;
  try {
    const ok = globalShortcut.register('CommandOrControl+P', _ctrlPHandler);
    if (ok) {
      _ctrlPRegistered = true;
      log('[CTRL+P] Hook clavier global Ctrl+P ACTIF');
    } else {
      log('[CTRL+P] ERREUR: globalShortcut register echoue (deja pris ?)');
    }
  } catch (e) {
    log('[CTRL+P] Exception lors du setup: ' + e.message);
  }
}

function startPrintJobMonitor() {
  if (_wmiProcess) return;

  const { spawn } = require('child_process');
  const psScript = `
$query = "SELECT * FROM __InstanceCreationEvent WITHIN 0.3 WHERE TargetInstance ISA 'Win32_PrintJob'"
try {
  Register-WmiEvent -Query $query -SourceIdentifier "PecExpressPrintMonitor" -ErrorAction Stop
} catch {
  Write-Output "WMI_ERROR:$($_.Exception.Message)"
  exit 1
}
Write-Output "WMI_READY"
while ($true) {
  $ev = Wait-Event -SourceIdentifier "PecExpressPrintMonitor" -Timeout 600
  if ($ev -ne $null) {
    $job = $ev.SourceEventArgs.NewEvent.TargetInstance
    $ts = [DateTime]::Now.ToString("HH:mm:ss.fff")
    Write-Output "PRINTJOB|$ts|printer=$($job.Name)|doc=$($job.Document)|status=$($job.Status)"
    Remove-Event -EventIdentifier $ev.EventIdentifier
  }
}
`.trim();

  _wmiProcess = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  _wmiProcess.stdout.on('data', (data) => {
    const lines = data.toString().trim().split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      if (line.startsWith('WMI_READY')) {
        log('[WMI] Moniteur jobs impression ACTIF');
      } else if (line.startsWith('WMI_ERROR')) {
        log('[WMI] Erreur demarrage: ' + line);
      } else if (line.startsWith('PRINTJOB|')) {
        const parts = line.split('|');
        const ts = parts[1] || '?';
        const printer = parts[2] || '';
        const doc = parts[3] || '';
        _lastPrintJobTime = Date.now();
        log(`[WMI] *** CLIC IMPRIMER DETECTE *** t=0 | ${ts} | ${printer} | ${doc}`);

        // Mode 'logos' uniquement: CabFlowReader immediat (lecture directe BDD Logos)
        // Mode 'auto' et 'pdf': on attend le SPL PostScript (pipeline imprimante virtuelle).
        // En mode 'auto' le fallback Logos est declenche par processPostScriptSpool en cas d'echec.
        const printerLower = printer.toLowerCase();
        if (printerLower.includes('mon devis dentaire') || printerLower.includes('cabflow')) {
          let mode = 'auto';
          try {
            const { getConfig } = require('./config-manager');
            const cfg = getConfig();
            if (cfg && cfg.extractionMode) mode = cfg.extractionMode;
          } catch (e) {}

          if (mode === 'logos') {
            log('[WMI] mode=logos -> Lancement CabFlowReader (lecture directe Logos)...');
            showLoader();
            readAndOpenCabFlow(doc).then(success => {
              if (success) {
                log('[WMI] CabFlowReader OK — Chrome ouvert en ' + (Date.now() - _lastPrintJobTime) + 'ms');
                _cabflowHandledUntil = Date.now() + 10000;
              } else {
                hideLoader();
                log('[WMI] CabFlowReader echec');
              }
            }).catch(err => {
              hideLoader();
              log('[WMI] CabFlowReader exception: ' + err.message);
            });
          } else {
            log(`[WMI] mode=${mode} -> attente SPL PostScript (imprimante virtuelle)`);
            // Memoriser le docName pour le fallback Logos
            _lastDocName = doc;
            showLoader();
          }
        }
      }
    }
  });

  _wmiProcess.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) log('[WMI] stderr: ' + msg);
  });

  _wmiProcess.on('exit', (code) => {
    log('[WMI] Moniteur termine (code=' + code + ')');
    _wmiProcess = null;
  });

  log('[WMI] Demarrage moniteur jobs impression (WMI Win32_PrintJob)...');
}

/**
 * Traite un buffer PostScript capture par le spool-parser (NOUVELLE IMPRIMANTE VIRTUELLE)
 * PS -> PDF via Ghostscript -> texte positionne via mupdf -> devis-extractor
 *
 * C'est le pipeline PRIMAIRE en mode 'pdf' et 'auto'.
 */
async function processPostScriptSpool(captured) {
  const { extractFromPsBuffer, setLogger: setPsLogger } = require('./ps-to-pdf');
  const { extractFromPositionedText, buildDevisUrl, setLogger: setExtLogger } = require('./devis-extractor');
  const { getConfig } = require('./config-manager');
  const fs = require('fs');
  const T0 = Date.now();

  setPsLogger(log);
  setExtLogger(log);

  try {
    log('=== TRAITEMENT POSTSCRIPT ===');
    const sinceClic = _lastPrintJobTime ? `DEPUIS_CLIC=${Date.now() - _lastPrintJobTime}ms` : 'CLIC_NON_MESURE';
    log(`[TIMING] t=0ms | PS recu: ${captured.name} (${(captured.size / 1024).toFixed(1)} KB) | ${sinceClic}`);

    showLoader();

    const config = getConfig() || {};
    const opts = { keepFilesOnError: (config.pdfExtraction && config.pdfExtraction.keepPdfOnError) !== false };

    const { lines, chars, pdfPath, psPath } = await extractFromPsBuffer(captured.buffer, opts);
    log(`[TIMING] t=${Date.now() - T0}ms | ${lines.length} fragments texte extraits`);

    if (!lines || lines.length === 0) {
      log('[PS] Aucun texte extrait du PDF, abandon');
      hideLoader();
      return { success: false, reason: 'no-text' };
    }

    const data = extractFromPositionedText(lines, chars);
    log(`[TIMING] t=${Date.now() - T0}ms | extraction terminee, confiance=${data.confidence}`);

    const minConfidence = (config.pdfExtraction && config.pdfExtraction.minConfidence) || 60;
    if (data.confidence < minConfidence) {
      log(`[PS] Confiance trop faible (${data.confidence} < ${minConfidence}), echec`);
      hideLoader();
      return { success: false, reason: 'low-confidence', data };
    }

    if (!data.patient.nom || !data.patient.nir) {
      log('[PS] Patient incomplet (nom ou NIR manquant), echec');
      hideLoader();
      return { success: false, reason: 'incomplete-patient', data };
    }

    log(`[PS] Patient: ${data.patient.nom} ${data.patient.prenom || ''} | ${data.actes.length} acte(s) | numero devis: ${data.devis.numero || '?'}`);

    updateLoaderPatient({
      nom: data.patient.nom,
      prenom: data.patient.prenom,
      actes: data.actes
    });

    const url = buildDevisUrl(data);
    log('[PS] URL Mon devis dentaire COMPLETE:');
    log('[PS] ' + url);
    log('[PS] === DONNEES EXTRAITES ===');
    log('[PS] Patient: nom=' + data.patient.nom + ' | prenom=' + data.patient.prenom +
        ' | naissance=' + data.patient.dateNaissance + ' | NIR=' + data.patient.nir);
    log('[PS] Praticien: nom=' + data.praticien.nom + ' | ADELI=' + data.praticien.adeli +
        ' | RPPS=' + data.praticien.rpps);
    log('[PS] Cabinet: FINESS=' + data.cabinet.finess);
    log('[PS] Devis: numero=' + data.devis.numero + ' | date=' + (data.devis.devis || data.devis.date) +
        ' | validite=' + data.devis.validite);
    for (let i = 0; i < data.actes.length; i++) {
      const a = data.actes[i];
      log('[PS] Acte#' + (i + 1) + ': CCAM=' + a.code_ccam + ' | dents=' + a.numero_dent +
          ' | nature=' + a.nature_acte + ' | montant=' + a.montant +
          ' | panier=' + a.panier + ' | materiau=' + a.materiau);
    }
    log('[PS] Confiance=' + data.confidence + '/100');

    hideLoader();
    openUrlInBrowser(url);

    // Succes: supprimer PS+PDF temporaires
    try { fs.unlinkSync(psPath); } catch (e) {}
    try { fs.unlinkSync(pdfPath); } catch (e) {}

    log(`[TIMING] t=${Date.now() - T0}ms | FIN TRAITEMENT PS (succes)`);
    log('=== FIN TRAITEMENT POSTSCRIPT ===');
    return { success: true, data };
  } catch (e) {
    log('[PS] ERREUR: ' + e.message);
    hideLoader();
    return { success: false, reason: 'exception', error: e.message };
  }
}

/**
 * Traite un buffer XPS capture par le spool-parser
 * Extrait le texte via UnicodeString Glyphs, parse le devis, ouvre Mon devis dentaire dans Chrome
 */
async function processXpsSpool(captured) {
  const { parseXpsSpoolBuffer } = require('./xps-parser');
  const { parseDevis, buildDevisUrl } = require('./devis-parser');
  const T0 = Date.now();

  // Si CabFlowReader a deja ouvert Chrome pour ce job, on skip le spool (fenetre 10s)
  if (Date.now() < _cabflowHandledUntil) {
    log('[XPS] Skip — deja traite par CabFlowReader');
    return;
  }

  try {
    log('=== TRAITEMENT XPS ===');
    const sinceClic = _lastPrintJobTime ? `DEPUIS_CLIC=${Date.now() - _lastPrintJobTime}ms` : 'CLIC_NON_MESURE';
    log(`[TIMING] t=0ms | SPL recu: ${captured.name} (${(captured.size / 1024).toFixed(1)} KB) | ${sinceClic}`);

    showLoader();

    log(`[TIMING] t=${Date.now()-T0}ms | debut parse XPS`);
    const xps = parseXpsSpoolBuffer(captured.buffer);
    log(`[TIMING] t=${Date.now()-T0}ms | fin parse XPS`);
    if (!xps || !xps.textLines || xps.textLines.length === 0) {
      log('[XPS] Aucun texte extrait, abandon');
      hideLoader();
      return;
    }
    log(`[TIMING] t=${Date.now()-T0}ms | ${xps.textLines.length} lignes | debut parse devis`);

    const data = parseDevis(xps.textLines);
    log(`[TIMING] t=${Date.now()-T0}ms | fin parse devis`);
    if (!data) {
      log('[XPS] Devis non reconnu (nom ou NIR manquant), abandon');
      hideLoader();
      return;
    }
    log(`[TIMING] t=${Date.now()-T0}ms | Patient: ${data.patient.nom} ${data.patient.prenom} | ${data.actes.length} acte(s)`);

    const url = buildDevisUrl(data);
    log('[XPS] URL Mon devis dentaire: ' + url);

    hideLoader();

    // Ouvrir dans Chrome
    log(`[TIMING] t=${Date.now()-T0}ms | ouverture Chrome...`);
    try {
      const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
      if (fs.existsSync(chromePath)) {
        const { spawn } = require('child_process');
        const child = spawn(chromePath, [url], { detached: true, stdio: 'ignore' });
        child.unref();
        log(`[TIMING] t=${Date.now()-T0}ms | Chrome lance via spawn: ${chromePath}`);
      } else {
        log(`[TIMING] t=${Date.now()-T0}ms | Chrome non trouve, fallback shell.openExternal`);
        shell.openExternal(url);
      }
    } catch (chromeErr) {
      log(`[TIMING] t=${Date.now()-T0}ms | Erreur Chrome: ${chromeErr.message}`);
      try { shell.openExternal(url); } catch (e2) { log('[XPS] shell.openExternal echoue: ' + e2.message); }
    }

    log(`[TIMING] t=${Date.now()-T0}ms | FIN TRAITEMENT`);
    log('=== FIN TRAITEMENT XPS ===');
  } catch (e) {
    log('[XPS] ERREUR: ' + e.message);
    hideLoader();
  }
}

// Fonctions de compatibilite (diagnostic supprime, remplace par spool-parser + emfspool-parser)
function startSpoolTestWatcher() { /* noop - remplace par startSpoolWatcher dans spool-parser.js */ }
function stopSpoolTestWatcher() { /* noop */ }

/**
 * Traiter un fichier recu
 */
async function processFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    log('Traitement fichier: ' + path.basename(filePath) + ' (' + stats.size + ' bytes)');

    // Upload fichier vers le cloud (extraction mupdf)
    log('Envoi du document au cloud pour traitement...');

    // Le loader est déjà affiché par le watcher

    const result = await uploadToCloud(filePath);

    // CACHER LE LOADER
    hideLoader();

    if (result && result.success && result.redirect_url) {
      log('Succès ! URL de redirection reçue: ' + result.redirect_url);

      const url = result.redirect_url;
      log('Ouverture navigateur: ' + url);

      // Sur macOS et Windows, tenter d'ouvrir avec Chrome
      if (process.platform === 'darwin') {
        const { exec } = require('child_process');
        exec(`open -a "Google Chrome" "${url}"`, (error) => {
          if (error) {
            shell.openExternal(url);
          }
        });
      } else if (process.platform === 'win32') {
        const { exec, execSync } = require('child_process');

        log('=== DEBUT OUVERTURE CHROME (Windows) ===');
        log('[CHROME] URL a ouvrir: ' + url);
        log('[CHROME] ProgramFiles: ' + (process.env['ProgramFiles'] || 'NON DEFINI'));
        log('[CHROME] ProgramFiles(x86): ' + (process.env['ProgramFiles(x86)'] || 'NON DEFINI'));
        log('[CHROME] LocalAppData: ' + (process.env['LocalAppData'] || 'NON DEFINI'));
        log('[CHROME] USERPROFILE: ' + (process.env['USERPROFILE'] || 'NON DEFINI'));

        const chromePaths = [];

        // Methode 0: Registre HKLM (la plus fiable)
        log('[CHROME] === Methode 0: Registre HKLM ===');
        try {
          const regResult = execSync(
            'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
            { encoding: 'utf8', timeout: 5000 }
          );
          log('[CHROME] Registre HKLM brut: ' + regResult.trim());
          const regMatch = regResult.match(/REG_SZ\s+(.+)/);
          if (regMatch && regMatch[1]) {
            const p = regMatch[1].trim();
            log('[CHROME] HKLM chemin: ' + p + ' -> existe: ' + fs.existsSync(p));
            if (fs.existsSync(p)) chromePaths.push(p);
          }
        } catch (e) {
          log('[CHROME] HKLM non trouve: ' + e.message.split('\n')[0]);
        }

        // Methode 1: Registre HKCU (install par utilisateur)
        log('[CHROME] === Methode 1: Registre HKCU ===');
        try {
          const regResult2 = execSync(
            'reg query "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
            { encoding: 'utf8', timeout: 5000 }
          );
          log('[CHROME] Registre HKCU brut: ' + regResult2.trim());
          const regMatch2 = regResult2.match(/REG_SZ\s+(.+)/);
          if (regMatch2 && regMatch2[1]) {
            const p = regMatch2[1].trim();
            log('[CHROME] HKCU chemin: ' + p + ' -> existe: ' + fs.existsSync(p));
            if (fs.existsSync(p)) chromePaths.push(p);
          }
        } catch (e) {
          log('[CHROME] HKCU non trouve: ' + e.message.split('\n')[0]);
        }

        // Methode 2: where chrome
        log('[CHROME] === Methode 2: where chrome ===');
        try {
          const whereResult = execSync('where chrome', { encoding: 'utf8', timeout: 5000 });
          log('[CHROME] where chrome: ' + whereResult.trim());
          const wherePath = whereResult.trim().split('\n')[0].trim();
          if (wherePath && fs.existsSync(wherePath)) chromePaths.push(wherePath);
        } catch (e) {
          log('[CHROME] where chrome: pas dans le PATH');
        }

        // Methode 3: Chemins standards en dur
        log('[CHROME] === Methode 3: Chemins standards ===');
        const standardPaths = [
          path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['LocalAppData'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
          path.join(process.env['USERPROFILE'] || '', 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        ];
        standardPaths.forEach((p, i) => {
          const exists = fs.existsSync(p);
          log('[CHROME] Standard[' + i + ']: ' + p + ' -> ' + exists);
          if (exists && !chromePaths.includes(p)) chromePaths.push(p);
        });

        // Methode 4: Chercher dans le registre les navigateurs installes
        log('[CHROME] === Methode 4: Registre StartMenuInternet ===');
        try {
          const regBrowsers = execSync(
            'reg query "HKLM\\SOFTWARE\\Clients\\StartMenuInternet" /s /f "chrome.exe" /d',
            { encoding: 'utf8', timeout: 5000 }
          );
          log('[CHROME] StartMenuInternet: ' + regBrowsers.trim().substring(0, 500));
        } catch (e) {
          log('[CHROME] StartMenuInternet: ' + e.message.split('\n')[0]);
        }

        // Methode 5: wmic
        log('[CHROME] === Methode 5: wmic ===');
        try {
          const wmicResult = execSync(
            'wmic process where "name=\'chrome.exe\'" get ExecutablePath /format:list 2>nul',
            { encoding: 'utf8', timeout: 5000 }
          );
          log('[CHROME] wmic chrome: ' + wmicResult.trim());
          const wmicMatch = wmicResult.match(/ExecutablePath=(.+)/);
          if (wmicMatch && wmicMatch[1]) {
            const p = wmicMatch[1].trim();
            log('[CHROME] wmic chemin: ' + p + ' -> existe: ' + fs.existsSync(p));
            if (fs.existsSync(p) && !chromePaths.includes(p)) chromePaths.push(p);
          }
        } catch (e) {
          log('[CHROME] wmic: ' + e.message.split('\n')[0]);
        }

        log('[CHROME] === RESUME: ' + chromePaths.length + ' chemins Chrome trouves ===');
        chromePaths.forEach((p, i) => log('[CHROME]   [' + i + '] ' + p));

        let chromeFound = false;
        for (const chromePath of chromePaths) {
          if (chromePath && fs.existsSync(chromePath)) {
            log('[CHROME] LANCEMENT: ' + chromePath);
            const cmd = `"${chromePath}" "${url}"`;
            log('[CHROME] Commande: ' + cmd);
            exec(cmd, (error, stdout, stderr) => {
              if (error) {
                log('[CHROME] ERREUR exec: ' + error.message);
              } else {
                log('[CHROME] Chrome lance avec succes !');
              }
            });
            chromeFound = true;
            break;
          }
        }

        if (!chromeFound) {
          log('[CHROME] !!!! CHROME NON TROUVE - AUCUN CHEMIN VALIDE !!!!');
          log('[CHROME] Tentative "start chrome" via cmd...');
          exec(`cmd /c start chrome "${url}"`, (error) => {
            if (error) {
              log('[CHROME] "start chrome" ECHEC: ' + error.message);
              log('[CHROME] Dernier recours: shell.openExternal (= navigateur par defaut = probablement Edge)');
              shell.openExternal(url);
            } else {
              log('[CHROME] "start chrome" OK !');
            }
          });
        }
        log('=== FIN OUVERTURE CHROME (Windows) ===');
      } else {
        shell.openExternal(url);
      }

      // Notification
      if (Notification.isSupported()) {
        new Notification({
          title: 'PecExpress',
          body: 'Document envoyé avec succès'
        }).show();
      }

    } else {
      log('Erreur ou réponse invalide du serveur: ' + JSON.stringify(result));
      // Fallback: ouvrir la page d'accueil en cas d'erreur
      shell.openExternal(CONFIG.siteUrl + '/prises-en-charge/nouvelle?error=upload_failed');
    }

    // Deplacer le fichier vers un dossier traite
    const processedDir = path.join(getLogsPath(), 'processed');
    if (!fs.existsSync(processedDir)) {
      fs.mkdirSync(processedDir, { recursive: true });
    }
    // Rename with timestamp
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = path.extname(filePath);
    const baseName = path.basename(filePath, ext);
    const newName = `${baseName}_${timestamp}${ext}`;
    const newPath = path.join(processedDir, newName);

    fs.renameSync(filePath, newPath);
    log('Fichier deplace vers: ' + newPath);

  } catch (error) {
    hideLoader(); // S'assurer que le loader disparaît en cas d'erreur
    log('Erreur traitement: ' + error.message);
    shell.openExternal(CONFIG.siteUrl + '/prises-en-charge/nouvelle?error=processing_error');
  }
}

/**
 * Extraire le texte structuré du PDF avec mupdf (positions x/y préservées)
 */
/**
 * Charge mupdf (gere asar Electron vs dev mode)
 */
async function loadMupdf() {
  const isAsar = __dirname.includes('app.asar');
  if (isAsar) {
    const { pathToFileURL } = require('url');
    const unpackedPath = path.join(__dirname, '..', '..', 'node_modules', 'mupdf', 'dist', 'mupdf.js')
      .replace('app.asar', 'app.asar.unpacked');
    const mupdfUrl = pathToFileURL(unpackedPath).href;
    log(`[EXTRACT] mupdf (asar unpacked): ${unpackedPath}`);
    return await import(mupdfUrl);
  } else {
    log('[EXTRACT] mupdf (dev mode)');
    return await import('mupdf');
  }
}

/**
 * Extrait le texte structure d'un document mupdf (PDF ou XPS)
 */
function extractTextFromDocument(doc) {
  const pageCount = doc.countPages();
  const pages = [];

  for (let i = 0; i < pageCount; i++) {
    const page = doc.loadPage(i);
    const bounds = page.getBounds();
    const pageWidth = bounds[2] - bounds[0];
    const pageHeight = bounds[3] - bounds[1];

    const stText = page.toStructuredText('preserve-whitespace');
    const structured = JSON.parse(stText.asJSON());

    const elements = [];
    for (const block of structured.blocks) {
      if (!block.lines) continue;
      for (const line of block.lines) {
        if (!line.text || !line.text.trim()) continue;
        elements.push({
          text: line.text.trim(),
          x: Math.round(line.x),
          y: Math.round(line.y),
          w: Math.round(line.bbox?.w || 0),
          h: Math.round(line.bbox?.h || 0),
          fontSize: line.font?.size || 0
        });
      }
    }

    pages.push({ page: i + 1, width: pageWidth, height: pageHeight, elements });
  }

  return { pages };
}

/**
 * Pipeline Mac : extrait le texte depuis le PDF (fonctionne parfaitement)
 */
async function extractPdfText(filePath) {
  const mupdf = await loadMupdf();
  const fileData = fs.readFileSync(filePath);
  const doc = mupdf.Document.openDocument(fileData, 'application/pdf');
  return extractTextFromDocument(doc);
}

/**
 * Upload les données extraites du PDF au cloud (JSON texte + positions)
 */
async function uploadToCloud(filePath) {
  const fetch = require('node-fetch');

  try {
    const pdfSize = fs.statSync(filePath).size;
    log('=== EXTRACTION DEVIS ===');
    log(`[EXTRACT] Fichier: ${path.basename(filePath)} (${(pdfSize / 1024).toFixed(1)} KB)`);

    const extractStart = Date.now();
    log('[EXTRACT] Pipeline unifie: extraction mupdf depuis le PDF');
    const extractedData = await extractPdfText(filePath);
    const extractDuration = Date.now() - extractStart;

    const totalElements = extractedData.pages.reduce((s, p) => s + p.elements.length, 0);
    const jsonPayload = JSON.stringify(extractedData);
    const jsonSize = Buffer.byteLength(jsonPayload);

    log(`[EXTRACT] Extraction terminee en ${extractDuration}ms`);
    log(`[EXTRACT] Pages: ${extractedData.pages.length} | Elements: ${totalElements}`);
    log(`[EXTRACT] Taille JSON: ${(jsonSize / 1024).toFixed(1)} KB (PDF: ${(pdfSize / 1024).toFixed(1)} KB, ratio: ${(pdfSize / jsonSize).toFixed(1)}x)`);

    // Log details par page
    for (const page of extractedData.pages) {
      log(`[EXTRACT] Page ${page.page}: ${page.elements.length} elements, dimensions: ${page.width}x${page.height}pt`);

      // Log plages de positions pour verification dimensionnelle
      if (page.elements.length > 0) {
        const xMin = Math.min(...page.elements.map(e => e.x));
        const xMax = Math.max(...page.elements.map(e => e.x + e.w));
        const yMin = Math.min(...page.elements.map(e => e.y));
        const yMax = Math.max(...page.elements.map(e => e.y + e.h));
        const fontSizes = [...new Set(page.elements.map(e => e.fontSize))].sort((a, b) => a - b);
        log(`[EXTRACT] Page ${page.page} positions: x[${xMin}-${xMax}] y[${yMin}-${yMax}] fontSizes: [${fontSizes.join(', ')}]`);
      }
    }

    // Log les premiers elements pour verification rapide dans les logs
    const preview = extractedData.pages[0]?.elements.slice(0, 5) || [];
    for (const elem of preview) {
      log(`[EXTRACT] Preview: "${elem.text}" @ (${elem.x}, ${elem.y}) ${elem.w}x${elem.h} fontSize=${elem.fontSize}`);
    }

    log(`[UPLOAD] Envoi JSON au cloud (${(jsonSize / 1024).toFixed(1)} KB)...`);
    const uploadStart = Date.now();

    const response = await fetch('https://app.mondevisdentaire.com/api/desktop/process-pdf', {
      method: 'POST',
      body: jsonPayload,
      headers: { 'Content-Type': 'application/json' }
    });

    const uploadDuration = Date.now() - uploadStart;

    if (!response.ok) {
      throw new Error(`HTTP Error: ${response.status}`);
    }

    const result = await response.json();
    log(`[UPLOAD] Reponse recue en ${uploadDuration}ms`);
    log(`[EXTRACT] Total: extraction ${extractDuration}ms + upload ${uploadDuration}ms = ${extractDuration + uploadDuration}ms`);
    log('=== FIN EXTRACTION DEVIS ===');

    return result;
  } catch (e) {
    log('[EXTRACT] ERREUR: ' + e.message);
    return { success: false, error: e.message };
  }
}

/**
 * Configurer les handlers IPC
 */
function setupIpcHandlers() {
  log('[IPC] Setup des handlers IPC...');

  ipcMain.handle('get-config', () => {
    log('[IPC] get-config appele');
    return CONFIG;
  });

  ipcMain.handle('set-config', (event, key, value) => {
    log('[IPC] set-config: ' + key + ' = ' + value);
    if (CONFIG.hasOwnProperty(key)) {
      CONFIG[key] = value;
    }
    return { success: true };
  });

  ipcMain.handle('get-extraction-mode', () => {
    try {
      const { getConfig } = require('./config-manager');
      const cfg = getConfig() || {};
      return cfg.extractionMode || 'auto';
    } catch (e) { return 'auto'; }
  });

  ipcMain.handle('set-extraction-mode', (event, mode) => {
    if (!['auto', 'pdf', 'logos'].includes(mode)) {
      return { success: false, error: 'Mode invalide (auto|pdf|logos)' };
    }
    try {
      const { setOverride } = require('./config-manager');
      setOverride('extractionMode', mode);
      log('[IPC] Mode extraction change: ' + mode);
      return { success: true, mode };
    } catch (e) {
      log('[IPC] Erreur set-extraction-mode: ' + e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-status', () => {
    log('[IPC] get-status appele');
    const installed = printerExists();
    const version = app.getVersion();
    log('[IPC] get-status -> version=' + version + ', printer=' + installed + ', platform=' + process.platform);
    return {
      printerInstalled: installed,
      version: version,
      platform: process.platform
    };
  });

  ipcMain.handle('reinstall-printer', async () => {
    log('Reinstallation imprimante demandee');
    try {
      await installPrinterWithAdmin();
      return { success: true };
    } catch (error) {
      log('Erreur installation imprimante: ' + error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-printer-status', () => {
    const { execSync } = require('child_process');
    try {
      if (process.platform === 'win32') {
        const result = execSync('powershell -NoProfile -Command "Get-Printer -Name \'Mon devis dentaire PEC\' -ErrorAction SilentlyContinue"', { encoding: 'utf8' });
        if (result.includes('Lancer la DPEC')) {
          return { installed: true, status: 'ready' };
        }
      } else {
        const result = execSync('lpstat -p PECExpress_PEC 2>&1', { encoding: 'utf8' });
        if (result.includes('PECExpress_PEC')) {
          return { installed: true, status: 'ready' };
        }
      }
    } catch (e) { }
    return { installed: false, status: 'not_installed' };
  });

  ipcMain.handle('open-logs-folder', () => {
    const logsDir = getLogsPath();
    log('[IPC] open-logs-folder: ' + logsDir);
    if (!fs.existsSync(logsDir)) {
      log('[IPC] Dossier logs inexistant, creation...');
      fs.mkdirSync(logsDir, { recursive: true });
    }
    log('[IPC] Ouverture du dossier: ' + logsDir);
    shell.openPath(logsDir).then((err) => {
      if (err) log('[IPC] ERREUR ouverture dossier: ' + err);
      else log('[IPC] Dossier ouvert avec succes');
    });
    return { success: true };
  });

  ipcMain.handle('read-logs', () => {
    log('[IPC] read-logs appele');
    try {
      const logFile = path.join(getLogsPath(), 'app.log');
      log('[IPC] Lecture fichier: ' + logFile);
      log('[IPC] Fichier existe: ' + fs.existsSync(logFile));
      if (fs.existsSync(logFile)) {
        const content = fs.readFileSync(logFile, 'utf8');
        const lines = content.split('\n');
        const last500 = lines.slice(-500).join('\n');
        log('[IPC] read-logs OK: ' + lines.length + ' lignes totales');
        return { success: true, content: last500, path: logFile, totalLines: lines.length };
      }
      log('[IPC] read-logs: fichier introuvable');
      return { success: false, error: 'Fichier de logs introuvable: ' + logFile };
    } catch (e) {
      log('[IPC] read-logs ERREUR: ' + e.message);
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('test-print', () => {
    const testFile = path.join(getSpoolPath(), 'test_' + Date.now() + '.txt');
    fs.writeFileSync(testFile, 'Test PecExpress Desktop');
    log('Fichier test cree: ' + testFile);
    return { success: true };
  });

  ipcMain.handle('get-version', () => {
    return app.getVersion();
  });

  // Handlers pour la config cloud
  ipcMain.handle('get-cloud-config', () => {
    return getConfig();
  });

  ipcMain.handle('set-config-override', (event, key, value) => {
    setOverride(key, value);
    log('Override config: ' + key + ' = ' + JSON.stringify(value));
    return { success: true };
  });

  ipcMain.handle('set-default-printer', async () => {
    const logs = [];
    function addLog(msg) {
      const l = `[${new Date().toISOString()}] ${msg}`;
      logs.push(l);
      log(msg);
    }

    addLog('=== Début définition imprimante par défaut (Mode Force) ===');

    try {
      const { execSync } = require('child_process');

      let success = false;

      // 0. Désactiver "Laisser Windows gérer mon imprimante par défaut"
      addLog('Désactivation "Laisser Windows gérer..."');
      try {
        // LegacyDefaultPrinterMode = 1 signifie "Ne pas laisser Windows gérer"
        execSync('reg add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows" /v LegacyDefaultPrinterMode /t REG_DWORD /d 1 /f');
        addLog('Registre mis à jour');
      } catch (e) {
        addLog('Erreur Registre: ' + e.message);
      }

      // Méthode 1: WMI via PowerShell
      addLog('Tentative 1: PowerShell WMI...');
      try {
        const cmd = 'powershell -Command "$p = Get-WmiObject -Class Win32_Printer -Filter \\"Name=\'Mon devis dentaire PEC\'\\"; if($p){ $p.SetDefaultPrinter() } else { throw \'Imprimante introuvable\' }"';
        execSync(cmd, { encoding: 'utf8' });
        addLog('Succès commande PowerShell WMI');
        success = true;
      } catch (e) {
        addLog('ECHEC PowerShell WMI: ' + e.message);
      }

      // Méthode 2: VBS
      if (!success) {
        addLog('Tentative 2: VBS...');
        try {
          const setScript = `
                   var network = WScript.CreateObject("WScript.Network");
                   network.SetDefaultPrinter("Mon devis dentaire PEC");
                   `;
          const tempVbs = path.join(os.tmpdir(), 'setdefault.vbs');
          fs.writeFileSync(tempVbs, setScript);
          execSync(`cscript //Nologo "${tempVbs}"`);
          fs.unlinkSync(tempVbs);
          addLog('Succès commande VBS');
          success = true;
        } catch (e2) {
          addLog('ECHEC VBS: ' + e2.message);
        }
      }

      // Méthode 3: RUNDLL32
      if (!success) {
        addLog('Tentative 3: RUNDLL32...');
        try {
          execSync('rundll32 printui.dll,PrintUIEntry /y /n "Mon devis dentaire PEC"');
          addLog('Succès commande RUNDLL32');
          success = true;
        } catch (e3) {
          addLog('ECHEC RUNDLL32: ' + e3.message);
        }
      }

      // 4. Redémarrage du Spooler (Nécessite Admin, peut échouer si pas admin)
      addLog('Tentative redémarrage Spooler (pour forcer le rafraîchissement)...');
      try {
        execSync('powershell -Command "Restart-Service Spooler -Force -ErrorAction SilentlyContinue"');
        addLog('Spooler redémarré');
      } catch (e) {
        addLog('Note: Impossible de redémarrer le spooler (probablement manque de droits): ' + e.message);
      }

      // Vérification finale
      addLog('Vérification du statut par défaut...');
      let actualDefault = "Inconnu";
      try {
        const def = execSync('powershell -Command "Get-CimInstance -ClassName Win32_Printer -Property Name,Default | Where-Object {$_.Default -eq $true} | Select-Object -ExpandProperty Name"', { encoding: 'utf8' }).trim();
        actualDefault = def;
        addLog('Imprimante actuellement par défaut: "' + def + '"');
      } catch (e) {
        addLog('Impossible de vérifier le défaut: ' + e.message);
      }

      if (actualDefault.includes('Mon devis dentaire PEC')) {
        addLog('CONFIRMATION: Mon devis dentaire PEC est bien par défaut !');
        return { success: true, logs: logs };
      } else {
        addLog(`ATTENTION: Le système dit que "${actualDefault}" est par défaut.`);
        return { success: false, error: "Windows refuse de la mettre par défaut", logs: logs };
      }

    } catch (error) {
      addLog('ERREUR CRITIQUE: ' + error.message);
      return { success: false, error: error.message, logs: logs };
    }
  });
}

// ============================================
// Lifecycle de l'application
// ============================================

// Empecher les instances multiples
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  log('[CRITICAL] Impossible d\'obtenir le verrou d\'instance unique. L\'application est probablement déjà lancée.');
  
  // Afficher un message à l'utilisateur avant de quitter
  app.whenReady().then(() => {
    dialog.showErrorBox(
      "Mon devis dentaire Connecté est déjà lancé",
      "Une autre instance de l'application est déjà en cours d'exécution.\n\nVeuillez vérifier dans la barre des tâches ou fermer l'autre instance avant de recommencer."
    );
    app.quit();
  });
} else {
  // Modules internes chargés de manière sécurisée
  const { loadConfig, getConfig, startUpdateChecker, setOverride } = require('./config-manager');

  // Configurer les chemins AVANT toute autre chose
  try {
    const userDataPath = path.join(app.getPath('appData'), 'logos-connect');
    app.setPath('userData', userDataPath);
    log('UserData path défini: ' + userDataPath);
  } catch (e) {
    log('Erreur définition userData: ' + e.message);
  }

  // Gérer la deuxième instance
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });



  // Quand l'app est prete
  app.whenReady().then(async () => {
    try {
      log('=======================================================');
      log('=== DEMARRAGE LOGOS CONNECT v' + app.getVersion() + ' ===');
      log('=======================================================');

      // ===== AUTO-FEATURES (boot, watchdog, update) =====
      const autoFeatures = require('./auto-features');
      autoFeatures.setLogger(log);
      autoFeatures.clearManualQuitFlag();    // boot => clear le flag
      autoFeatures.setupAutoStart();          // demarrage Windows
      autoFeatures.setupAutoUpdate();         // check update toutes les heures

      // ===== DEMARRAGE LOGOS CONNECT : tray-only, AUCUNE fenetre =====
      // Pas de bootstrap "PecExpress Desktop", pas d'install imprimante, pas de setup window.
      // Le service Windows PecExpressService + DLL injection gerent tout.
      app.setAppUserModelId("fr.mondevisdentaire.connecte");

      setupIpcHandlers();
      ensureDirectories();
      loadConfig().then(() => {
        log('Configuration chargee OK');
        startUpdateChecker();
      }).catch(err => {
        log('Erreur chargement config: ' + err.message);
      });
      createTray();
      // [OPT v1.0.16] Loader window pre-creee desactivee (gain ~80 MB)
      // createLoaderWindow();
      // [OPT v1.0.16] WebSocket port 8082 desactive (legacy PecExpress Desktop, gain ~30 MB)
      // startWebSocketServer();
      startPecExpressPipeListener();

      // Module dashboard (fenetre tray + watcher temps reel DLL/Service)
      try {
        const dashboard = require('./dashboard');
        dashboard.init({ logger: log, isQuittingRef: () => isQuitting });
        log('[STARTUP] Dashboard initialise');
      } catch (e) {
        log('[STARTUP] Erreur init dashboard (non bloquant): ' + e.message);
      }

      // [OPT v1.0.16] Modules legacy PecExpress Desktop desactives (pas d'imprimante en Mon devis dentaire Connecté)
      // - spool-parser, emfspool-parser, logos-watcher, startPrintJobMonitor
      // Gain attendu: ~50 MB + moins de FS watchers + moins de WMI subscriptions
      // (Si besoin de re-tester avec ces modules, decommenter le bloc ci-dessous)
      /*
      if (process.platform === 'win32') {
        const spoolParser = require('./spool-parser');
        const { setLogger: setEmfLogger } = require('./emfspool-parser');
        spoolParser.setLogger(log);
        setEmfLogger(log);
        spoolParser.setOnCapture((captured) => {
          log(`[STARTUP] Capture ${captured.format}, routage...`);
          handleCapturedSpool(captured).catch(err => {
            log('[STARTUP] Erreur routage capture: ' + err.message);
            hideLoader();
          });
        });
        spoolParser.startSpoolWatcher();
        startPrintJobMonitor();
        try {
          const logosWatcher = require('./logos-watcher');
          logosWatcher.setLogger(log);
          logosWatcher.startWatcher();
        } catch (e) {}
      }
      */

      log('=======================================================');
      log('=== APPLICATION DEMARREE AVEC SUCCES v' + app.getVersion() + ' ===');
      log('=======================================================');
    } catch (criticalError) {
      log('[CRITICAL] Erreur fatale au démarrage: ' + criticalError.message);
      dialog.showErrorBox(
        "Erreur fatale au démarrage",
        "L'application n'a pas pu démarrer pour la raison suivante :\n\n" + criticalError.message + "\n\nContactez le support si le problème persiste."
      );
    }
  });

  // Garder l'app en vie meme si toutes les fenetres sont fermees
  app.on('window-all-closed', () => {
    // Ne pas quitter sur macOS
  });

  // macOS: reactiver la fenetre
  app.on('activate', () => {
    showSettings();
  });

  // Avant de quitter
  app.on('before-quit', () => {
    isQuitting = true;
    if (watcher) {
      watcher.close();
    }
    stopSpoolTestWatcher();
    try { globalShortcut.unregisterAll(); } catch (e) {}
    log('Application fermee');
  });
}
