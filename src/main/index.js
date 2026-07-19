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
  const backendSrc = path.join(__dirname, '..', '..', 'resources', 'mac', 'mdd-backend');
  const ppdSrc = path.join(__dirname, '..', '..', 'resources', 'mac', 'PECExpress_PEC.ppd');

  return new Promise((resolve, reject) => {
    log('Installation de l\'imprimante PecExpress (macOS)...');
    log('Backend source: ' + backendSrc);
    log('PPD source: ' + ppdSrc);

    const installScript = `
do shell script "
  mkdir -p /var/spool/mdd
  chmod 777 /var/spool/mdd
  cp '${backendSrc}' /usr/libexec/cups/backend/mdd
  chown root:wheel /usr/libexec/cups/backend/mdd
  chmod 700 /usr/libexec/cups/backend/mdd
  cp '${ppdSrc}' /etc/cups/ppd/PECExpress_PEC.ppd
  chown root:_lp /etc/cups/ppd/PECExpress_PEC.ppd
  chmod 644 /etc/cups/ppd/PECExpress_PEC.ppd
  launchctl kickstart -k system/org.cups.cupsd 2>/dev/null || (launchctl stop org.cups.cupsd; sleep 1; launchctl start org.cups.cupsd)
  sleep 2
  lpadmin -x PECExpress_PEC 2>/dev/null || true
  lpadmin -p PECExpress_PEC -D 'Lancer la DPEC' -L 'PecExpress' -v 'mdd:/' -P '/etc/cups/ppd/PECExpress_PEC.ppd' -o printer-is-shared=false -E
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

// Numéro de support affiché dans les pop-ups de blocage. Surchargable par cabinet
// via config (config.supportPhone, ex. renseigné par la config cloud/overrides)
// pour ne pas diffuser un numéro personnel en dur à tous les cabinets.
const SUPPORT_PHONE_DEFAULT = '06 46 73 10 65';
function supportPhone() {
  try {
    const p = (require('./config-manager').getConfig() || {}).supportPhone;
    if (p && String(p).trim()) return String(p).trim();
  } catch (e) {}
  return SUPPORT_PHONE_DEFAULT;
}

// ============================================
// MDDREADER READER — Lecture directe Logos (< 100ms, sans impression)
// ============================================

// Deadline: jusqu'a ce timestamp, tout spool est skippe (MddReader a deja ouvert Chrome)
// Expire automatiquement apres 10s pour permettre au pipeline XPS de reprendre en cas d'echec WMI
let _mddHandledUntil = 0;

/**
 * Trouve le chemin de MddReader.exe dans les emplacements connus
 */
function findMddReader() {
  const candidates = [
    // extraResources packagé (production portable) — process.resourcesPath/resources/win/
    path.join(process.resourcesPath || '', 'resources', 'win', 'MddReader.exe'),
    // extraResources via execPath (production)
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', 'MddReader.exe'),
    // Ressources directes (production alternative)
    path.join(path.dirname(process.execPath), 'resources', 'win', 'MddReader.exe'),
    // Ressources en mode dev (electron dev)
    path.join(__dirname, '..', '..', 'resources', 'win', 'MddReader.exe'),
    // ProgramData (installation stable)
    'C:\\ProgramData\\PecExpress\\MddReader.exe',
    // AppData Local
    path.join(os.homedir(), 'AppData', 'Local', 'PecExpress', 'MddReader.exe'),
    // Desktop (fallback dev)
    path.join(os.homedir(), 'Desktop', 'MddReader.exe'),
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
 * Construit le CHEMIN RELATIF du wizard PEC prérempli depuis les données
 * MddReader JSON (commun à toutes les voies d'ouverture).
 */
function buildWizardPath(data) {
  // Tolérant aux DEUX formes d'actes : MddReader mémoire ({ccam,nom,honoraires,dent})
  // ET parseur serveur logosw ({code,libelle,montant,dent,materiau,panier}). Les deux
  // voies (devis + PEC) convergent ainsi vers le même parcours prérempli.
  const actes = (data.actes || []).map(a => ({
    code_ccam: a.ccam || a.code || a.code_ccam || '',
    nature_acte: a.nom || a.libelle || a.nature_acte || '',
    montant: String(a.honoraires != null ? a.honoraires : (a.montant != null ? a.montant : 0)),
    numero_dent: String(a.dent || a.numero_dent || '').replace(/\s+/g, ','),
    panier: a.panier || '',
    materiau: a.materiau || '',
    // Détails Assurance Maladie Obligatoire : base de remboursement Sécu,
    // montant remboursé (AMO) et non remboursé — bien parsés côté serveur mais
    // qui étaient LARGUÉS ici (seuls 6 champs transmis). Le prefill les lit sous
    // baseRemb/base, montantRemb/amo, montantNonRemb/reste.
    baseRemb: String(
      a.baseRemb != null ? a.baseRemb
      : a.base != null ? a.base
      : a.baseRemboursement != null ? a.baseRemboursement
      : ''
    ),
    montantRemb: String(a.montantRemb != null ? a.montantRemb : (a.amo != null ? a.amo : '')),
    montantNonRemb: String(a.montantNonRemb != null ? a.montantNonRemb : (a.reste != null ? a.reste : '')),
  }));
  const prat = data.praticienInfo || {};
  const mut = data.mutuelle || {};
  const params = new URLSearchParams({
    source: 'mdd-desktop',
    type: 'pec', // entre directement dans le parcours PEC (saute l'ecran de choix)
    // NUMERO du dossier Logos : c'est le pivot qui permet, apres signature, de
    // reecrire les documents (ligne "envoye pour signature" + docs signes) dans
    // le BON dossier patient Logos. Sans lui, le connecteur ne sait pas ou ecrire.
    logos_numero: (data.logosNumero != null ? String(data.logosNumero) : ''),
    source_system: 'logos',
    nom: data.nom || '',
    prenom: data.prenom || '',
    date_naissance: data.dateNaissance || '',
    nir: data.nir || '',
    nir_cle: data.nirCle || '',
    email: data.email || '',
    // Téléphone patient (portable lu dans CIVIL.FIC) — le prefill le lit sous
    // le param `telephone`, puis il est stocké sur patients.phone à la création.
    telephone: data.portable || '',
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
  return '/prises-en-charge/nouvelle?' + params.toString();
}

/**
 * URL d'ouverture SANS auto-login (repli). Cabinet Labora : iframe MDD dans
 * Labora (SSO si session Labora active). Cabinet non-Labora : onglet MDD direct.
 * Dans les deux cas une session navigateur est nécessaire.
 */
function buildMddUrl(data) {
  const wizardPath = buildWizardPath(data);
  let isLabora = false;
  try {
    const _c = require('./config-manager').getConfig();
    isLabora = /laboradental/i.test((_c && _c.urls && _c.urls.site) || '');
  } catch (e) {}
  if (isLabora) {
    return 'https://app.laboradental.fr/app/dentiste/pec?next=' + encodeURIComponent(wizardPath);
  }
  return 'https://app.mondevisdentaire.com' + wizardPath;
}

/**
 * Ouvre l'assistant PEC AVEC auto-login : le connecteur (appairé, clé API du
 * cabinet) demande au serveur un lien de connexion à usage unique
 * (/api/desktop/session), puis ouvre l'assistant DÉJÀ connecté — plus aucune
 * saisie de mot de passe. Repli sur buildMddUrl (session requise) si
 * l'auto-login échoue (pas de clé, réseau, etc.).
 */
async function openPecWizard(data) {
  const wizardPath = buildWizardPath(data);

  // OVERRIDE UNIVERSEL : auto-login MDD direct via /api/desktop/session (le
  // connecteur possede la cle MDD du cabinet). Vaut pour TOUS les cabinets, lies
  // a Labora ou non -> plus jamais d'ecran de connexion. Pour un cabinet Labora,
  // la PEC s'ouvre dans MDD (mode « gere par Labora »), pas dans l'iframe Labora
  // (impossible d'outrepasser la session Labora sans identifiants Labora).
  try {
    const fetch = require('node-fetch');
    const { getConfig } = require('./config-manager');
    const cfg = getConfig() || {};
    const apiKey = cfg.apiKey || '';
    const site = CONFIG.siteUrl;
    if (apiKey) {
      const prat = data.praticienInfo || {};
      const agendaName = data.praticien || [prat.prenom, prat.nom].filter(Boolean).join(' ') || undefined;
      const resp = await fetch(site + '/api/desktop/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ redirectPath: wizardPath, agendaName }),
      });
      const j = await resp.json().catch(() => ({}));
      if (resp.ok && j && j.url) {
        log('[PEC] Auto-login desktop OK -> ouverture de l assistant deja connecte');
        openUrlInBrowser(j.url);
        return;
      }
      log('[PEC] Auto-login desktop indisponible (' + ((j && j.error) || ('HTTP ' + resp.status)) + ') -> repli session navigateur');
    } else {
      log('[PEC] Aucune cle API -> pas d auto-login, repli session navigateur');
    }
  } catch (e) {
    log('[PEC] Auto-login desktop exception (' + e.message + ') -> repli session navigateur');
  }
  // Repli : comportement historique (Labora iframe ou MDD direct).
  openUrlInBrowser(buildMddUrl(data));
}

/**
 * Envoi de devis au patient - comportement IDENTIQUE a l'extension Chrome :
 * poste le devis a /api/devis/share du site (cabinet identifie par x-api-key).
 * Le serveur envoie l'email au patient avec le bouton "espace patient", relance
 * chaque semaine sans reponse, et stoppe si un RDV de traitement est planifie.
 *
 * @param {Object} data - devis + patient issus de readAndOpenMdd (clean)
 * @returns {Promise<boolean>}
 */
// --- Fenetre de saisie de l'email patient avant envoi du devis ---
let _devisEmailWin = null;
let _devisEmailResolver = null;
let _devisEmailInfo = null;

/**
 * Ouvre une petite fenetre avec l'email patient (prerempli, modifiable) + un
 * bouton Envoyer. Resout { confirmed:boolean, email:string }.
 */
function promptDevisEmail(info) {
  return new Promise((resolve) => {
    if (_devisEmailResolver) { const r = _devisEmailResolver; _devisEmailResolver = null; r({ confirmed: false }); }
    if (_devisEmailWin && !_devisEmailWin.isDestroyed()) { try { _devisEmailWin.destroy(); } catch (e) {} }
    _devisEmailInfo = info || {};
    _devisEmailResolver = resolve;
    try {
      _devisEmailWin = new BrowserWindow({
        width: 470, height: 340,
        resizable: false, minimizable: false, maximizable: false,
        title: 'Envoi de devis', alwaysOnTop: true, autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false, contextIsolation: true,
          preload: path.join(__dirname, '..', 'preload.js'),
        },
      });
      _devisEmailWin.on('closed', () => {
        _devisEmailWin = null;
        if (_devisEmailResolver) { const r = _devisEmailResolver; _devisEmailResolver = null; r({ confirmed: false }); }
      });
      _devisEmailWin.loadFile(path.join(__dirname, '..', 'renderer', 'devis-email.html'));
    } catch (e) {
      log("[DEVIS] Impossible d'ouvrir la fenetre email: " + e.message);
      _devisEmailResolver = null;
      resolve({ confirmed: false });
    }
  });
}

/**
 * Rafraichit l'etat des modules (PEC / Devis) depuis le site via
 * /api/desktop/whoami et le memorise localement. Pilote quels boutons de
 * l'overlay s'affichent dans Logos.
 */
async function refreshModules() {
  try {
    const cm = require('./config-manager');
    const cfg = cm.getConfig() || {};
    const apiKey = cfg.apiKey || '';
    if (!apiKey) return; // poste pas encore appaire
    // /api/desktop/* n'existe que sur le host MDD (pas sur la façade Labora).
    const site = CONFIG.siteUrl;
    const fetch = require('node-fetch');
    const res = await fetch(site + '/api/desktop/whoami', { headers: { 'x-api-key': apiKey } });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json && json.ok && json.modules) {
      cm.setOverride('modules', { pec: json.modules.pec !== false, devis: json.modules.devis !== false });
      log('[MODULES] pec=' + (json.modules.pec !== false) + ' devis=' + (json.modules.devis !== false));
    }
  } catch (e) {
    log('[MODULES] refresh echec (non bloquant): ' + e.message);
  }
}

/**
 * Enregistre CE poste auprès du serveur (garde-fou multi-poste — observabilité).
 * Remonte l'identité UNIQUE du magasin de données Logos (storeId = fichier
 * .mdd\store-id.txt du dossier patients partagé) + l'IDPOSTE + des infos
 * d'affichage. Le serveur classe le poste (même magasin = même cabinet).
 * Non bloquant : n'empêche jamais l'appairage ni le fonctionnement.
 */
async function registerPoste() {
  try {
    const cm = require('./config-manager');
    const cfg = cm.getConfig() || {};
    const apiKey = cfg.apiKey || '';
    if (!apiKey) return; // pas encore appairé
    // Les routes /api/desktop/* vivent sur le host MDD, même pour un cabinet
    // Labora (la façade laboradental.fr ne les sert pas) -> on force le host MDD,
    // comme les watchers questionnaire/FSE. (cfg.urls.site = Labora => 405.)
    const site = CONFIG.siteUrl;

    const ini = require('./logos-ini').readIni(cfg.logosIniPath);
    const patientsDir = ini.patientsDir || cfg.logosPatientsDir || null;
    if (!patientsDir) { log('[POSTE] dossier patients inconnu -> enregistrement différé'); return; }

    const storeIdMod = require('./logos-store-id');
    const storeId = storeIdMod.readOrCreateStoreId(patientsDir);
    const share = storeIdMod.deriveShare(patientsDir);
    const os = require('os');
    const practitioners = [(ini.codes || []).join(','), ini.nomUtil || ''].filter(Boolean).join(' — ') || null;

    const payload = {
      idPoste: ini.idPoste || os.hostname(), // repli hostname si IDPOSTE absent
      hostname: os.hostname(),
      storeId: storeId || null,
      patientsShare: share || null,
      practitioners,
    };
    const fetch = require('node-fetch');
    const res = await fetch(site + '/api/desktop/poste-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j && j.ok) {
      // Verrou d'activité : le poste ne travaille que si le serveur l'a approuvé.
      try { const gate = require('./poste-gate'); gate.setLogger(log); gate.setStatus(j.status); } catch (e) {}
      log('[POSTE] enregistré (statut ' + (j.status || '?') + ', store ' + String(storeId || '—').slice(0, 8) + ')');
    } else {
      log('[POSTE] enregistrement HTTP ' + res.status);
    }
  } catch (e) {
    log('[POSTE] enregistrement échec (non bloquant): ' + e.message);
  }
}

/**
 * Parseur devis CÔTÉ SERVEUR — helper PARTAGÉ par la voie « Devis » et la voie
 * « PEC » (principe : le connecteur est un RELAIS, tout passe par le serveur).
 * Envoie le PDF officiel Logos au parseur du site (/api/devis/parse, profil
 * "logosw" = convention CNAM 2018) et renvoie { devisRef, dateDevis,
 * totalMontant, actes[], patient } ou null si aucun PDF / échec / 0 acte.
 * NE LÈVE JAMAIS : en cas d'erreur, renvoie null → l'appelant retombe sur les
 * actes lus en mémoire (comportement historique préservé, jamais bloquant).
 */
async function fetchServerParsedDevis(site, pdfBase64, pdfFileName) {
  if (!pdfBase64) {
    log('[PARSE] Pas de PDF officiel -> parseur serveur impossible, repli local');
    return null;
  }
  try {
    const fetch = require('node-fetch');
    const FormData = require('form-data');
    const pdfBuf = Buffer.from(pdfBase64, 'base64');
    const fd = new FormData();
    fd.append('file', pdfBuf, { filename: pdfFileName || 'devis.pdf', contentType: 'application/pdf' });
    fd.append('software', 'logosw');
    const pr = await fetch(site + '/api/devis/parse', { method: 'POST', body: fd, headers: fd.getHeaders() });
    const pj = await pr.json().catch(() => ({}));
    const pActes = (pj && Array.isArray(pj.actes)) ? pj.actes : [];
    if (pr.ok && pActes.length) {
      log('[PARSE] Parsé côté serveur (logosw): ' + pActes.length + ' actes, total=' +
          (pj.totalMontant != null ? pj.totalMontant : '?'));
      return {
        devisRef: pj.devisRef || undefined,
        dateDevis: pj.dateDevis || undefined,
        totalMontant: (typeof pj.totalMontant === 'number') ? pj.totalMontant : undefined,
        actes: pActes, // format compatible /api/devis/share ET desktop-prefill
        patient: {
          nom: (pj.patient && pj.patient.nom) || '',
          prenom: (pj.patient && pj.patient.prenom) || '',
          dateNaissance: (pj.patient && pj.patient.dateNaissance) || '',
          nir: (pj.patient && pj.patient.nir) || '',
          nirCle: (pj.patient && pj.patient.nirCle) || '',
        },
        // Praticien du devis (nom « Docteur … » + N°RPPS), extrait par le MÊME
        // parse serveur -> sert au contrôle de compte SANS re-parser le PDF.
        praticien: {
          nom: (pj.praticien && pj.praticien.nom) || '',
          rpps: (pj.praticien && pj.praticien.rpps) || '',
        },
      };
    }
    log('[PARSE] Parseur serveur: ' + ((pj && pj.error) || ('0 acte / HTTP ' + pr.status)) + ' -> repli local');
    return null;
  } catch (eP) {
    log('[PARSE] Parseur serveur exception (' + eP.message + ') -> repli local');
    return null;
  }
}

/**
 * Résout le compte praticien MDD à partir de l'identité DÉJÀ parsée (nom+RPPS),
 * SANS re-parser le PDF (simple lookup base côté serveur). Renvoie
 * { blocked, message }. En cas d'erreur réseau : blocked=false (on ne casse pas
 * un envoi légitime sur un souci technique).
 */
async function resolvePraticienAccount(site, apiKey, praticien, intent) {
  try {
    const fetch = require('node-fetch');
    const res = await fetch(site + '/api/desktop/praticien-resolve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({
        nom: (praticien && praticien.nom) || '',
        rpps: (praticien && praticien.rpps) || '',
        intent: intent || 'pec',
      }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok && j && j.blocked) return { blocked: true, message: j.message || '' };
    return { blocked: false, message: null };
  } catch (e) {
    log('[PRATICIEN] Résolution compte échouée (non bloquant): ' + e.message);
    return { blocked: false, message: null };
  }
}

async function sendDevisToPatient(data) {
  const fetch = require('node-fetch');
  const { getConfig } = require('./config-manager');
  const cfg = getConfig() || {};
  // Le devis + toute l'infra (API /api/devis/share, table devis, stockage PDF,
  // retour des docs signes) vivent sur le host MDD, meme pour un cabinet Labora
  // (la facade laboradental.fr ne sert pas ces routes -> HTTP 405). La cle API
  // du cabinet est valide cote MDD, donc on force toujours le host MDD ici.
  const site = CONFIG.siteUrl;
  const apiKey = cfg.apiKey || '';

  if (!apiKey) {
    // Poste non appairé : on ouvre directement la fenêtre « Connecter ce poste »
    // pour que l'utilisateur colle sa clé sur-le-champ (onboarding fluide).
    log('[DEVIS] Poste non appairé -> ouverture de la fenêtre de connexion');
    try { openConnectWindow(); } catch (e) { log('[DEVIS] ouverture fenêtre connexion KO: ' + e.message); }
    return false;
  }

  // Garde-fou : poste en attente/refusé -> en veille, aucun envoi.
  if (require('./poste-gate').isBlocked()) {
    log('[DEVIS] Poste en attente de validation -> envoi bloqué');
    require('./block-popup').show({
      tone: 'info',
      heading: "Poste en attente de validation",
      message: "Ce poste doit être approuvé par votre administrateur dans Mon Devis Dentaire (superadmin › Postes Logos) avant de pouvoir envoyer.",
      phone: supportPhone(),
    });
    return false;
  }

  let email = (data.email || '').trim();
  const phone = (data.portable || '').trim();

  const actes = (data.actes || []).map(a => ({
    code: a.ccam || '',
    dent: (a.dent || '').replace(/\s+/g, ','),
    libelle: a.nom || '',
    montant: a.honoraires != null ? Number(a.honoraires) : 0,
    baseRemb: a.base != null ? Number(a.base) : 0,
    montantRemb: a.amo != null ? Number(a.amo) : 0,
    montantNonRemb: a.reste != null ? Number(a.reste) : 0,
  }));

  const total = data.honorairesTotal != null
    ? Number(data.honorairesTotal)
    : actes.reduce((sum, a) => sum + (Number(a.montant) || 0), 0);

  const who = [data.prenom, data.nom].filter(Boolean).join(' ') || 'ce patient';
  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  // Si une adresse email valide est DEJA enregistree (lue dans Logos), on envoie
  // DIRECTEMENT : ni fenetre de saisie, ni popup de confirmation. La fenetre de
  // saisie de l'email ne s'ouvre QUE s'il n'y a pas d'email valide enregistre.
  const emailWasRegistered = EMAIL_RE.test(email);
  if (!emailWasRegistered) {
    const prompt = await promptDevisEmail({ who, email, acteCount: actes.length, total: total.toFixed(2) });
    if (!prompt || !prompt.confirmed) { log('[DEVIS] Envoi annule par le praticien'); return false; }
    email = (prompt.email || '').trim();
    if (!EMAIL_RE.test(email)) {
      log('[DEVIS] Email invalide/absent apres saisie: "' + email + '"');
      require('./block-popup').show({
        tone: 'error',
        heading: "Adresse email invalide",
        message: "Le devis n'a pas été envoyé : renseignez une adresse email valide.",
      });
      return false;
    }
  } else {
    log('[DEVIS] Email deja enregistre (' + email + ') -> envoi direct sans popup');
  }

  // PDF OFFICIEL du devis Logos : Logos l'enregistre dans
  // <patientsDir>\LIENS\<numero>\Devis-<devisId>*.pdf lors d'un Shift+clic sur
  // l'imprimante (impression + sauvegarde). On le joint s'il est present ; sinon
  // envoi sans PDF (non bloquant), et on le loggue pour diagnostic.
  let pdfBase64, pdfFileName;
  try {
    const devisPdf = require('./logos-devis-pdf');
    devisPdf.setLogger(log);
    let found = devisPdf.findLatestDevisPdf(data.patientsDir, data.logosNumero, data.devisId);
    // Filet de securite anti-course : si le PDF n'est pas encore la (Logos finit
    // de l'ecrire), on patiente et on re-scanne AVANT d'envoyer -> on ne part
    // jamais sans le PDF a cause d'un envoi trop tot.
    for (let i = 0; i < 8 && !found; i++) {
      await new Promise(r => setTimeout(r, 800));
      found = devisPdf.findLatestDevisPdf(data.patientsDir, data.logosNumero, data.devisId);
      if (found) log('[DEVIS] PDF disponible apres attente (~' + ((i + 1) * 800) + 'ms)');
    }
    if (found) {
      pdfBase64 = found.base64;
      pdfFileName = found.fileName;
      log('[DEVIS] PDF officiel Logos joint: ' + found.fileName + ' (' + found.sizeKb + ' Ko)');
    } else {
      log('[DEVIS] Aucun PDF officiel Logos trouve apres attente -> envoi sans PDF');
    }
  } catch (ePdf) {
    log('[DEVIS] Erreur lecture PDF devis (non bloquant): ' + ePdf.message);
  }

  // === PARSING CÔTÉ SERVEUR (principe : le connecteur est un RELAIS) ===
  // On n'envoie PAS les actes lus en mémoire : on transmet le PDF officiel au
  // parseur du serveur (helper fetchServerParsedDevis, profil "logosw"), et
  // c'est SON résultat qui alimente l'espace patient — exactement comme la voie
  // PEC et l'extension Chrome. Repli sur les actes locaux si le parseur échoue.
  let devisData = null;
  const parsed = await fetchServerParsedDevis(site, pdfBase64, pdfFileName);
  let devisPraticien = null;
  if (parsed && Array.isArray(parsed.actes) && parsed.actes.length) {
    devisPraticien = parsed.praticien || null;
    devisData = {
      devisRef: parsed.devisRef || (data.devisId != null ? String(data.devisId) : undefined),
      dateDevis: parsed.dateDevis || undefined,
      totalMontant: (typeof parsed.totalMontant === 'number') ? parsed.totalMontant : undefined,
      actes: parsed.actes,
      patient: {
        nom: (parsed.patient && parsed.patient.nom) || data.nom || '',
        prenom: (parsed.patient && parsed.patient.prenom) || data.prenom || '',
        dateNaissance: (parsed.patient && parsed.patient.dateNaissance) || data.dateNaissance || '',
        nir: (parsed.patient && parsed.patient.nir) || data.nir || '',
      },
    };
  }
  // Parse serveur KO -> PAS de repli local (lent) : on bloque et on invite à appeler.
  if (!devisData) {
    log('[DEVIS] Parseur serveur indisponible -> envoi bloque (appeler Olivier)');
    require('./block-popup').show({
      tone: 'error',
      heading: "Devis non analysable",
      message: "Le devis n'a pas pu être analysé automatiquement : il n'a pas été envoyé au patient.",
      phone: supportPhone(),
    });
    return false;
  }

  // Contrôle compte praticien : identité DÉJÀ parsée -> lookup base, SANS re-parse.
  try {
    const chk = await resolvePraticienAccount(site, apiKey, devisPraticien, 'devis');
    if (chk && chk.blocked) {
      log('[DEVIS] Praticien sans compte MDD -> envoi bloque');
      require('./block-popup').show({
        tone: 'blocked',
        heading: "Praticien sans compte MDD",
        message: "Le praticien de ce devis n'a pas de compte sur Mon Devis Dentaire. Le devis n'a pas été envoyé. Appelez Olivier pour qu'il crée votre espace.",
        phone: supportPhone(),
      });
      return false;
    }
  } catch (eChk) {
    log('[DEVIS] Controle compte praticien echoue (non bloquant): ' + eChk.message);
  }

  const payload = {
    devisData,
    patient: {
      email,
      phone,
      nom: (devisData.patient && devisData.patient.nom) || data.nom || '',
      prenom: (devisData.patient && devisData.patient.prenom) || data.prenom || '',
      dateNaissance: data.dateNaissance || '',
    },
    channels: { email: true },
    // Origine du devis : permet au retour du document signe de revenir dans
    // le bon systeme (ici Logos) et le bon dossier (NUMERO).
    source: {
      system: data.sourceSystem || 'logos',
      patientRef: (data.logosNumero != null) ? String(data.logosNumero) : '',
      praticien: data.praticien || '',
      // Identité praticien DÉJÀ parsée -> le serveur résout le compte SANS
      // re-parser le PDF (évite un 2e parse à l'envoi).
      praticienNom: (devisPraticien && devisPraticien.nom) || '',
      praticienRpps: (devisPraticien && devisPraticien.rpps) || '',
    },
    // PDF officiel Logos (si Shift+clic imprimante a ete fait avant l'envoi).
    pdfBase64,
    pdfFileName,
  };

  log('[DEVIS] POST ' + site + '/api/devis/share (' + actes.length + ' actes, ' +
      total.toFixed(2) + ' EUR, email=' + (email || 'aucun') + ')');
  try {
    const res = await fetch(site + '/api/devis/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    let json = {};
    try { json = JSON.parse(txt); } catch (e) {}

    if (res.status === 403 && /parsing/i.test(txt)) {
      log('[DEVIS] Parsing non encore valide (403): ' + txt.slice(0, 200));
      require('./block-popup').show({
        tone: 'info',
        heading: "Logiciel en cours de validation",
        message: "L'envoi de devis sera disponible sous 24 h (validation du format Logos). Le devis n'a pas été envoyé.",
      });
      return false;
    }

    if (!res.ok || json.ok === false || json.error) {
      const msg = (json && json.error) || ('HTTP ' + res.status);
      log('[DEVIS] Echec envoi: ' + msg + ' - ' + txt.slice(0, 200));
      require('./block-popup').show({
        tone: 'error',
        heading: "Envoi impossible",
        message: "Le devis n'a pas pu être envoyé. " + msg,
      });
      return false;
    }

    log('[DEVIS] Devis envoye OK - id=' + (json.devisId || '?') + ' url=' + (json.publicUrl || '?'));

    // === JOURNAL LOGOS : trace l'envoi pour signature dans le dossier patient ===
    // Ecrit une ligne cliquable "Devis pour un montant de XXX EUR envoye pour
    // signature" (meme mecanisme que le retour des docs signes, via ACTES_2).
    // ASCII UNIQUEMENT (pas d'accents) pour ne pas corrompre le champ EXTRA Logos.
    // Non bloquant : un echec d'ecriture n'empeche pas l'envoi du devis.
    if (pdfBase64 && data.logosNumero != null) {
      try {
        const logosWriter = require('./logos-devis-writer');
        logosWriter.setLogger(log);
        const buf = Buffer.from(pdfBase64, 'base64');
        const ref = String(json.devisId || data.devisId || Date.now())
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .slice(0, 40);
        const label = 'Devis pour un montant de ' + total.toFixed(2) + ' EUR envoye pour signature';
        // Auteur = code praticien lu dans Logos (data.praticien, ex. "OS"),
        // dynamique pour le multi-praticien ; si absent, null -> writeSignedDoc
        // prend le code praticien de LOGOS_w.INI (portable) au lieu de 'OS' en dur.
        const rLog = await logosWriter.writeSignedDoc(
          data.logosNumero, buf, `Devis-envoye-${ref}.pdf`, label, data.praticien || null
        );
        log('[DEVIS] Ligne Logos "envoye pour signature" ecrite (dossier ' +
            data.logosNumero + ', cle=' + (rLog && rLog.cle) + ')');
      } catch (eLog) {
        log('[DEVIS] Ecriture ligne Logos (non bloquant) echouee: ' + eLog.message);
      }
    } else {
      log('[DEVIS] Pas de PDF/numero Logos -> pas de ligne "envoye pour signature" ecrite');
    }

    // Popup de confirmation UNIQUEMENT quand on a du demander l'email (aucun email
    // enregistre). Si l'email etait deja enregistre -> envoi silencieux.
    if (!emailWasRegistered) {
      require('./block-popup').show({
        tone: 'success',
        heading: "Devis envoyé à " + who,
        message: email
          ? ("Un email vient d'être envoyé à " + email + " avec le lien vers l'espace patient. Relance automatique chaque semaine sans réponse.")
          : "Le devis a été enregistré.",
      });
    }
    return true;
  } catch (e) {
    log('[DEVIS] Exception envoi: ' + e.message);
    require('./block-popup').show({
      tone: 'error',
      heading: "Erreur réseau",
      message: "Erreur réseau lors de l'envoi du devis. " + e.message,
    });
    return false;
  }
}

/**
 * Fenetre d'appairage du poste : le praticien colle la cle "Connecteur"
 * (Parametres > Connecteur). On appelle /api/desktop/whoami pour recuperer la
 * bonne base (MDD ou Labora) et on memorise cle + urls dans la config locale.
 */
function openConnectWindow() {
  try {
    const win = new BrowserWindow({
      width: 470, height: 360,
      resizable: false, minimizable: false, maximizable: false,
      title: 'Connecter ce poste',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '..', 'preload.js'),
      },
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'connect.html'));
  } catch (e) {
    log("[PAIR] Impossible d'ouvrir la fenetre d'appairage: " + e.message);
  }
}

/**
 * Lit le devis courant via MddReader.exe et ouvre Mon devis dentaire dans Chrome
 * @param {string} docName - Nom du document depuis WMI (peut contenir l'ID du devis)
 * @returns {Promise<boolean>} true si Chrome a ete ouvert avec succes
 */
async function readAndOpenMdd(docName, intent) {
  const T0 = Date.now();

  // ── Gating module (pec/devis) AVANT toute ouverture de MDD ──────────────────
  // Le serveur bloque la SOUMISSION, mais pour la PEC l'ouverture du wizard se
  // fait localement (le serveur n'est appelé qu'à la fin). On refuse donc
  // d'ouvrir MDD ici si le module correspondant est désactivé pour le cabinet.
  // État lu depuis config-manager (rafraîchi via /api/desktop/whoami). Absent =
  // poste non appairé → fail-open (comportement historique).
  const effIntent = (intent || 'pec') === 'devis' ? 'devis' : 'pec';
  try {
    const cm = require('./config-manager');
    const modules = (cm.getConfig() || {}).modules || {};
    if (modules[effIntent] === false) {
      log('[MDDREADER] Module ' + effIntent + ' désactivé pour ce cabinet → ouverture MDD bloquée');
      try {
        const { Notification } = require('electron');
        new Notification({
          title: 'Mon devis dentaire',
          body: effIntent === 'pec'
            ? 'Le module « Prise en charge » est désactivé pour ce cabinet.'
            : 'Le module « Devis » est désactivé pour ce cabinet.',
        }).show();
      } catch (eN) { /* notif best-effort */ }
      return false;
    }
  } catch (eMod) {
    log('[MDDREADER] Lecture module échouée (fail-open): ' + eMod.message);
  }

  const mddPath = findMddReader();
  if (!mddPath) {
    log('[MDDREADER] MddReader.exe non trouve');
    return false;
  }
  log('[MDDREADER] Utilise: ' + mddPath);

  // docName = numero de dossier patient, lu par l'overlay dans le titre Logos
  // "<NUMERO> - <NOM Prenom>". On le passe comme patientId (arg1) pour que
  // MddReader localise le dossier DIRECTEMENT, sans dependre de la cle
  // PatientEnCours dans LOGOS_w.INI (qui n'est pas toujours ecrite -> echec).
  const args = [];
  const numMatch = (docName || '').match(/\b(\d{3,6})\b/);
  if (numMatch) {
    log('[MDDREADER] Numero dossier detecte dans docName "' + docName + '": ' + numMatch[1]);
    args.push(numMatch[1], numMatch[1]); // arg1=patientId(NUMERO du dossier), arg2=devis (fallback devis courant)
  } else {
    log('[MDDREADER] Aucun numero dans docName "' + docName + '" -> auto (INI)');
    args.push('0', '0');
  }

  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    let stdout = '';
    let stderr = '';

    // Capture aussi stderr pour extraire patientsDir + memoOffset utilises par MddReader
    let mmoCtx = { patientsDir: null, memoOffset: null, patientId: null, devisId: null, iniPath: null };
    const proc = spawn(mddPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', (d) => {
      const msg = d.toString('utf8').trim();
      if (msg) log('[MDDREADER] ' + msg);
      stderr += msg;
      // Parse les lignes "Patient=X Dir=Y" et "MemoOff=0xXXXX" / "Devis selectionne: X"
      const mDir = msg.match(/Patient=(\d+)\s+Dir=(.+)/);
      if (mDir) { mmoCtx.patientId = parseInt(mDir[1], 10); mmoCtx.patientsDir = mDir[2].trim(); }
      const mSel = msg.match(/Devis selectionne:\s*(\d+)\s+date=\d+\s+memoOff=0x([0-9A-Fa-f]+)/);
      if (mSel) { mmoCtx.devisId = parseInt(mSel[1], 10); mmoCtx.memoOffset = parseInt(mSel[2], 16); }
      // Chemin du LOGOS_w.INI (loggue par MddReader) -> memorise pour la
      // decouverte portable des dossiers FSE (voir fse-watcher / logos-ini).
      const mIni = msg.match(/INI=([A-Za-z]:\\[^\r\n]+\.INI)/i);
      if (mIni) mmoCtx.iniPath = mIni[1].trim();
    });

    const timeout = setTimeout(() => {
      proc.kill();
      log('[MDDREADER] TIMEOUT 5s');
      resolve(false);
    }, 5000);

    proc.on('close', async (code) => {
      clearTimeout(timeout);
      const elapsed = Date.now() - T0;
      log('[MDDREADER] Termine en ' + elapsed + 'ms (code=' + code + ')');

      if (code !== 0 || !stdout.trim()) {
        log('[MDDREADER] Echec (code=' + code + '): ' + (stderr.split('\n')[0] || ''));
        resolve(false);
        return;
      }

      try {
        const data = JSON.parse(stdout);
        // Origine Logos : n° de dossier (NUMERO) pour que le document signe
        // revienne dans CE dossier Logos (pivot du retour des docs signes).
        data.sourceSystem = 'logos';
        data.logosNumero = (mmoCtx.patientId != null) ? mmoCtx.patientId : null;
        data.patientsDir = mmoCtx.patientsDir || null; // pour retrouver le PDF officiel Logos
        // Mémorise le dossier data Logos (per-cabinet) pour les retours de documents
        // (watchers), qui n'ont pas de contexte devis. Écrit seulement si ça change.
        if (mmoCtx.patientsDir) {
          try {
            const cmDir = require('./config-manager');
            if (((cmDir.getConfig() || {}).logosPatientsDir) !== mmoCtx.patientsDir) {
              cmDir.setOverride('logosPatientsDir', mmoCtx.patientsDir);
            }
          } catch (e) {}
        }
        // Memorise aussi le chemin du LOGOS_w.INI (decouverte FSE portable).
        if (mmoCtx.iniPath) {
          try {
            const cmIni = require('./config-manager');
            if (((cmIni.getConfig() || {}).logosIniPath) !== mmoCtx.iniPath) {
              cmIni.setOverride('logosIniPath', mmoCtx.iniPath);
            }
          } catch (e) {}
        }
        log('[MDDREADER] Patient: ' + data.nom + ' ' + data.prenom +
            ' | Devis: ' + data.devisId + ' | ' + (data.actes || []).length + ' actes' +
            ' | NIR: ' + (data.nir || 'ABSENT'));

        // === RE-PARSE PROPRE via notre parseur MMO Node.js ===
        // MddReader.exe a un bug: il ne strip pas les 12 bytes de header
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
            log('[MDDREADER] CLEAN parsing OK: ' + clean.actes.length + ' actes (vs ' +
                (data.actes || []).length + ' bruts MddReader), praticien=' + clean.praticien +
                ', honTotal=' + clean.honorairesTotal);

            // CROSS-CHECK: compare total UI (ce que voit l'utilisateur) vs total BDD
            const uiCtx = global._mddUiContext;
            if (uiCtx && uiCtx.honoraires > 0) {
                const diff = Math.abs(clean.honorairesTotal - uiCtx.honoraires);
                if (diff > 0.5) {  // tolere 50 centimes d'arrondi
                    log('[MDDREADER] MISMATCH UI=' + uiCtx.honoraires + '€ vs BDD=' +
                        clean.honorairesTotal + '€ (diff=' + diff.toFixed(2) +
                        '€) -> BDD pas a jour, on garde quand meme la BDD (devis non sauvegarde)');
                    clean._uiMismatch = { uiTotal: uiCtx.honoraires, bddTotal: clean.honorairesTotal, diff };
                } else {
                    log('[MDDREADER] UI/BDD MATCH (' + uiCtx.honoraires + '€) -> devis bien sauvegarde');
                }
            }

            // Override le data avec la version clean
            Object.assign(data, clean);
          } catch (eMmo) {
            log('[MDDREADER] WARN: re-parse MMO clean failed: ' + eMmo.message +
                ' - on garde le resultat MddReader brut');
          }
        } else {
          log('[MDDREADER] Contexte MMO absent (patientsDir/memoOffset), skip re-parse clean');
        }

        if (!data.nir) {
          log('[MDDREADER] WARN: NIR absent, URL sera incomplete');
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
              log('[MDDREADER] Mutuelle: ' + mutuelle.nom + ' AMC=' + mutuelle.numeroAMC +
                  ' adh=' + mutuelle.numeroAdherent + ' contrat=' + mutuelle.numeroContrat);
            } else {
              log('[MDDREADER] Pas de mutuelle trouvee pour ce patient');
            }
          } catch (eMut) {
            log('[MDDREADER] Erreur lecture mutuelle (non bloquant): ' + eMut.message);
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
            log('[MDDREADER] Email patient (CIVIL.FIC): ' + civ.email);
          } else {
            const memReader = require('./logos-memory-reader');
            const email = await memReader.readPatientEmail({ nom: data.nom, nir: data.nir });
            if (email) { data.email = email; log('[MDDREADER] Email patient (RAM fallback): ' + email); }
            else { log('[MDDREADER] Email patient introuvable'); }
          }
        } catch (eMail) {
          log('[MDDREADER] Erreur lecture email (non bloquant): ' + eMail.message);
        }

        // Pousse le nom patient + nb actes dans le loader (visible immediatement)
        updateLoaderPatient(data);

        // === INTENT DEVIS : envoi du devis au patient (email + espace patient
        // + relances hebdo), exactement comme l'extension Chrome. On N'OUVRE PAS
        // le wizard PEC : on poste le devis a /api/devis/share.
        if ((intent || 'pec') === 'devis') {
          // Un seul clic "Envoi de devis" declenche TOUTE la chaine :
          // 1) impression/enregistrement du PDF officiel Logos (Shift+clic
          //    imprimante, automatise), 2) lecture du PDF, 3) envoi au patient.
          // IMPORTANT : on masque l'overlay pendant l'impression, sinon il est
          // pose PAR-DESSUS l'icone imprimante et intercepte le clic simule.
          const overlayMod = require('./overlay-pec');
          try {
            overlayMod.setSuspended(true);
            await new Promise(r => setTimeout(r, 250)); // laisse l'overlay disparaitre du hit-test
            const printer = require('./logos-print-devis');
            printer.setLogger(log);
            await printer.printAndWaitPdf(data.patientsDir, data.logosNumero);
          } catch (ePrint) {
            log('[DEVIS] Impression auto du devis echouee (non bloquant): ' + ePrint.message);
          } finally {
            try { overlayMod.setSuspended(false); } catch (e) {}
          }
          try { await sendDevisToPatient(data); }
          catch (eDevis) { log('[DEVIS] Erreur envoi devis: ' + eDevis.message); }
          // Ré-affiche l'overlay épinglé pour que la confirmation « ✓ Envoyé »
          // (côté renderer, au retour de ce clic) soit bien visible après
          // l'impression (sinon l'overlay reste masqué si Logos n'est pas encore
          // redevenu la fenêtre active).
          try { overlayMod.keepVisibleForConfirmation(5000); } catch (e) {}
          resolve(true);
          return;
        }

        // === INTENT PEC : on route par le PARSEUR SERVEUR (comme la voie devis),
        // puis on ouvre le wizard PEC prérempli à l'étape actes. Le PRINT (shift+
        // clic imprimante invisible) doit se faire AVANT d'ouvrir le navigateur :
        // il exige que Logos soit au premier plan (l'ouverture du navigateur
        // volerait le focus). Et c'est ce parse serveur qui fournit le PANIER +
        // détails AMO complets. Repli sur les actes mémoire si le print/parse
        // échoue → jamais bloquant.
        let pecPraticien = null, pecParseFailed = false;
        try {
          const site = CONFIG.siteUrl;
          const overlayMod = require('./overlay-pec');
          let pecPdfB64 = null, pecPdfName = null;
          try {
            overlayMod.setSuspended(true);
            await new Promise(r => setTimeout(r, 250)); // laisse l'overlay quitter le hit-test
            const printer = require('./logos-print-devis');
            printer.setLogger(log);
            await printer.printAndWaitPdf(data.patientsDir, data.logosNumero);
          } catch (ePrint) {
            log('[PEC] Impression auto du devis échouée (non bloquant): ' + ePrint.message);
          } finally {
            try { overlayMod.setSuspended(false); } catch (e) {}
          }
          try {
            const devisPdf = require('./logos-devis-pdf');
            devisPdf.setLogger(log);
            // preferFreshest=true : on vient d'imprimer le devis ACTIF. Le devisId
            // lu en mémoire peut pointer sur l'ANCIEN devis → on prend le plus récent.
            let found = devisPdf.findLatestDevisPdf(data.patientsDir, data.logosNumero, data.devisId, true);
            for (let i = 0; i < 8 && !found; i++) {
              await new Promise(r => setTimeout(r, 800));
              found = devisPdf.findLatestDevisPdf(data.patientsDir, data.logosNumero, data.devisId, true);
            }
            if (found) { pecPdfB64 = found.base64; pecPdfName = found.fileName; }
          } catch (ePdf) {
            log('[PEC] Lecture PDF devis (non bloquant): ' + ePdf.message);
          }
          const parsedPec = await fetchServerParsedDevis(site, pecPdfB64, pecPdfName);
          if (parsedPec && Array.isArray(parsedPec.actes) && parsedPec.actes.length) {
            data.actes = parsedPec.actes; // actes parsés serveur = source de vérité (panier, AMO…)
            pecPraticien = parsedPec.praticien || null; // pour le contrôle de compte (sans re-parse)
            if (parsedPec.patient) {
              data.nom = parsedPec.patient.nom || data.nom;
              data.prenom = parsedPec.patient.prenom || data.prenom;
              data.dateNaissance = parsedPec.patient.dateNaissance || data.dateNaissance;
              data.nir = parsedPec.patient.nir || data.nir;
              data.nirCle = parsedPec.patient.nirCle || data.nirCle;
            }
            log('[PEC] Wizard prérempli depuis le parseur serveur (' + parsedPec.actes.length + ' actes)');
          } else {
            // Parse serveur KO -> PAS de repli local (lent). On bloque et on
            // invite à appeler (le devis n'est pas exploitable automatiquement).
            log('[PEC] Parseur serveur indisponible -> blocage (appeler Olivier)');
            pecParseFailed = true;
          }
        } catch (ePecParse) {
          log('[PEC] Parsing serveur PEC échoué: ' + ePecParse.message);
          pecParseFailed = true;
        }

        // Parse serveur KO -> message « appeler Olivier », wizard non ouvert.
        if (pecParseFailed) {
          try { hideLoader(); } catch (e) {}
          require('./block-popup').show({
            tone: 'error',
            heading: "Devis non analysable",
            message: "Le devis n'a pas pu être analysé automatiquement : la demande de prise en charge n'a pas été lancée.",
            phone: supportPhone(),
          });
          resolve(false);
          return;
        }

        // Poste non appairé : plutôt que d'ouvrir le wizard en login manuel, on
        // ouvre la fenêtre « Connecter ce poste » pour coller la clé sur-le-champ.
        {
          const { getConfig: getCfgPair } = require('./config-manager');
          if (!((getCfgPair() || {}).apiKey || '')) {
            log('[PEC] Poste non appairé -> ouverture de la fenêtre de connexion');
            try { hideLoader(); } catch (e) {}
            try { openConnectWindow(); } catch (e) { log('[PEC] ouverture fenêtre connexion KO: ' + e.message); }
            resolve(false);
            return;
          }
        }

        // Garde-fou : poste en attente/refusé -> en veille, PEC non lancée.
        if (require('./poste-gate').isBlocked()) {
          log('[PEC] Poste en attente de validation -> PEC bloquée');
          try { hideLoader(); } catch (e) {}
          require('./block-popup').show({
            tone: 'info',
            heading: "Poste en attente de validation",
            message: "Ce poste doit être approuvé par votre administrateur dans Mon Devis Dentaire (superadmin › Postes Logos) avant de pouvoir lancer une prise en charge.",
            phone: supportPhone(),
          });
          resolve(false);
          return;
        }

        // ── Contrôle compte praticien (SUR LOGOS, AVANT d'ouvrir Chrome) ─────
        // On réutilise le praticien DÉJÀ parsé (pecPraticien) -> simple lookup
        // base côté serveur, SANS re-parser le PDF (pas de 2e extraction). Si pas
        // de compte MDD -> pop-up native, wizard non ouvert.
        try {
          const { getConfig: getCfgChk } = require('./config-manager');
          const apiKeyChk = (getCfgChk() || {}).apiKey || '';
          if (apiKeyChk) {
            const chk = await resolvePraticienAccount(CONFIG.siteUrl, apiKeyChk, pecPraticien, 'pec');
            if (chk && chk.blocked) {
              log('[PEC] Praticien sans compte MDD -> blocage (wizard non ouvert)');
              try { hideLoader(); } catch (e) {}
              require('./block-popup').show({
                tone: 'blocked',
                heading: "Praticien sans compte MDD",
                message: "Le praticien de ce devis n'a pas de compte sur Mon Devis Dentaire. La demande de prise en charge n'a pas été lancée. Appelez Olivier pour qu'il crée votre espace.",
                phone: supportPhone(),
              });
              resolve(false);
              return;
            }
          }
        } catch (eChk) {
          log('[PEC] Controle compte praticien echoue (non bloquant): ' + eChk.message);
        }

        // Ouverture AVEC auto-login (magic-link via /api/desktop/session) ;
        // repli automatique sur la session navigateur si indisponible.
        log('[MDDREADER] Ouverture de l assistant PEC (auto-login desktop)...');
        await openPecWizard(data);
        // Ré-affiche l'overlay épinglé pour que la confirmation « ✓ Ouvert »
        // reste visible même quand Chrome passe au premier plan (l'overlay est
        // alwaysOnTop -> il flotte au-dessus le temps de la confirmation).
        try { require('./overlay-pec').keepVisibleForConfirmation(5000); } catch (e) {}
        resolve(true);
      } catch (e) {
        log('[MDDREADER] JSON parse error: ' + e.message);
        log('[MDDREADER] Stdout brut: ' + stdout.substring(0, 200));
        resolve(false);
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      log('[MDDREADER] Spawn error: ' + e.message);
      resolve(false);
    });
  });
}

// Chemins (multi-plateforme)
// macOS: /var/spool/mdd/ (CUPS backend)
// Windows: C:\ProgramData\PecExpress\spool\ (mfilemon - accessible par SYSTEM et User)
const getSpoolPath = () => {
  if (process.platform === 'win32') {
    return 'C:\\ProgramData\\PecExpress\\spool';
  }
  return '/var/spool/mdd';
};
const getLogsPath = () => path.join(os.homedir(), 'PecExpress', 'logs');

/**
 * Assurer que les dossiers existent
 * macOS: Le spool /var/spool/mdd/ est créé par l'installateur avec privilèges admin
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
        readAndOpenMdd(null).then(success => {
          if (success) {
            _mddHandledUntil = Date.now() + 10000;
            // Loader se ferme via blur ou safety timer
          } else {
            hideLoader();
            log('[TRAY] MddReader echec ou aucun patient actif');
          }
        }).catch(err => {
          hideLoader();
          log('[TRAY] exception: ' + err.message);
        });
      }
    },
    { type: 'separator' },
    {
      label: 'Connecter ce poste\u2026',
      click: openConnectWindow
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

  // Si MddReader a deja ouvert Chrome pour ce job, on skip le spool (fenetre 10s)
  if (Date.now() < _mddHandledUntil) {
    log('[EMFSPOOL] Skip — deja traite par MddReader');
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
      // Fallback MddReader (BDD - mais devis pas enregistre = potentiellement vieux)
      log(`[PEC] Fallback MddReader pour devis ${info.devisId}`);
      const ok = await readAndOpenMdd(info.devisId);
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
      source: 'mdd-desktop-overlay',
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
// Dernier docName WMI (utilise pour fallback MddReader si extraction PDF echoue)
let _lastDocName = null;

/**
 * Routeur unifie pour un SPL capture: route vers PS/XPS/EMF selon le format
 * et le mode d'extraction configure. En mode 'auto', si l'extraction PDF echoue,
 * tente le fallback Logos via MddReader.
 */
async function handleCapturedSpool(captured) {
  // Skip si MddReader a deja traite ce job (mode logos)
  if (Date.now() < _mddHandledUntil) {
    log(`[ROUTER] Skip ${captured.format} — deja traite par MddReader`);
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
      _mddHandledUntil = Date.now() + 10000;
      return;
    }
    // Echec extraction PDF -> fallback Logos en mode auto
    if (mode === 'auto') {
      log('[ROUTER] Echec PDF, fallback MddReader (Logos)...');
      showLoader();
      const ok = await readAndOpenMdd(_lastDocName || '');
      if (ok) {
        _mddHandledUntil = Date.now() + 10000;
      } else {
        hideLoader();
        log('[ROUTER] MddReader echec aussi, abandon');
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
        if (Date.now() < _mddHandledUntil) {
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

        // Mode 'logos' uniquement: MddReader immediat (lecture directe BDD Logos)
        // Mode 'auto' et 'pdf': on attend le SPL PostScript (pipeline imprimante virtuelle).
        // En mode 'auto' le fallback Logos est declenche par processPostScriptSpool en cas d'echec.
        const printerLower = printer.toLowerCase();
        if (printerLower.includes('mon devis dentaire') || printerLower.includes('mdd')) {
          let mode = 'auto';
          try {
            const { getConfig } = require('./config-manager');
            const cfg = getConfig();
            if (cfg && cfg.extractionMode) mode = cfg.extractionMode;
          } catch (e) {}

          if (mode === 'logos') {
            log('[WMI] mode=logos -> Lancement MddReader (lecture directe Logos)...');
            showLoader();
            readAndOpenMdd(doc).then(success => {
              if (success) {
                log('[WMI] MddReader OK — Chrome ouvert en ' + (Date.now() - _lastPrintJobTime) + 'ms');
                _mddHandledUntil = Date.now() + 10000;
              } else {
                hideLoader();
                log('[WMI] MddReader echec');
              }
            }).catch(err => {
              hideLoader();
              log('[WMI] MddReader exception: ' + err.message);
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

  // Si MddReader a deja ouvert Chrome pour ce job, on skip le spool (fenetre 10s)
  if (Date.now() < _mddHandledUntil) {
    log('[XPS] Skip — deja traite par MddReader');
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

  // Appairage du poste : valide la cle via /api/desktop/whoami et memorise
  // cle + base (MDD ou Labora) dans la config locale.
  ipcMain.handle('desktop-pair', async (event, key) => {
    const apiKey = (key || '').trim();
    if (!apiKey) return { ok: false, error: 'Cle vide' };
    const fetch = require('node-fetch');
    const cm = require('./config-manager');
    const probeBase = 'https://app.mondevisdentaire.com';
    try {
      const res = await fetch(probeBase + '/api/desktop/whoami', { headers: { 'x-api-key': apiKey } });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) return { ok: false, error: (json && json.error) || ('HTTP ' + res.status) };
      const base = json.base || probeBase;
      const pecNouvelle = json.pecNouvelle || (base + '/prises-en-charge/nouvelle');
      cm.setOverride('apiKey', apiKey);
      cm.setOverride('urls.site', base);
      cm.setOverride('urls.pecNouvelle', pecNouvelle);
      if (json.modules && typeof json.modules === 'object') {
        cm.setOverride('modules', { pec: json.modules.pec !== false, devis: json.modules.devis !== false });
      }
      log('[PAIR] Poste connecte a ' + (json.cabinetName || '?') + ' (' + base + ', labora=' + !!json.isLabora + ')');
      // Enregistre le poste (store-id + IDPOSTE) juste après l'appairage — garde-fou
      // multi-poste (observabilité). Non bloquant.
      try { registerPoste(); } catch (e) {}
      return { ok: true, cabinetName: json.cabinetName || '', base, isLabora: !!json.isLabora };
    } catch (e) {
      log('[PAIR] Erreur appairage: ' + e.message);
      return { ok: false, error: e.message };
    }
  });

  // Modules actifs (PEC / Devis) - pilote l'affichage des boutons overlay.
  ipcMain.handle('get-modules', () => {
    try {
      const m = (require('./config-manager').getConfig() || {}).modules || {};
      return { pec: m.pec !== false, devis: m.devis !== false };
    } catch (e) { return { pec: true, devis: true }; }
  });

  // Saisie email devis : la fenetre lit les infos initiales puis renvoie le resultat.
  ipcMain.handle('devis-email-get', () => _devisEmailInfo || {});
  ipcMain.on('devis-email-submit', (event, payload) => {
    const r = _devisEmailResolver;
    _devisEmailResolver = null;
    if (_devisEmailWin && !_devisEmailWin.isDestroyed()) { try { _devisEmailWin.close(); } catch (e) {} }
    if (r) r(payload && typeof payload === 'object' ? payload : { confirmed: false });
  });

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
        refreshModules();
        registerPoste();
        setInterval(() => { refreshModules(); registerPoste(); }, 15 * 60 * 1000);
      }).catch(err => {
        log('Erreur chargement config: ' + err.message);
      });
      createTray();
      // [OPT v1.0.16] Loader window pre-creee desactivee (gain ~80 MB)
      // createLoaderWindow();
      // [OPT v1.0.16] WebSocket port 8082 desactive (legacy PecExpress Desktop, gain ~30 MB)
      // startWebSocketServer();

      // Popup de blocage stylée (praticien sans compte / devis non analysable).
      try { require('./block-popup').setLogger(log); } catch (e) {}

      // Overlay flottant "Demande de PEC / Envoi de devis" sur la page Devis de Logos
      try {
        const overlay = require('./overlay-pec');
        overlay.setLogger(log);
        overlay.startOverlay(async (devisInfo, intent) => {
          const doc = devisInfo && devisInfo.devisId != null ? String(devisInfo.devisId) : null;
          const ok = await readAndOpenMdd(doc, intent || 'pec');
          return { success: ok };
        });
        // Refresh rapide des modules quand on arrive sur la page Devis (throttle
        // 20 s côté overlay) -> une désactivation PEC/Devis masque le bouton en
        // quelques secondes, sans attendre le refresh périodique (15 min).
        try { overlay.setOnDevisActive(refreshModules); } catch (e) {}
        log('[STARTUP] Overlay Logos demarre');
      } catch (eOv) {
        log('[STARTUP] Overlay non demarre: ' + eOv.message);
      }

      // Module dashboard (fenetre tray + watcher temps reel DLL/Service)
      try {
        const dashboard = require('./dashboard');
        dashboard.init({ logger: log, isQuittingRef: () => isQuitting });
        log('[STARTUP] Dashboard initialise');
      } catch (e) {
        log('[STARTUP] Erreur init dashboard (non bloquant): ' + e.message);
      }

      // Retour des documents signes : re-ecrit devis + consentement signes dans
      // le systeme d'origine (Logos). Poll MDD /api/desktop/signed-pending.
      try {
        const signedWatcher = require('./signed-docs-watcher');
        signedWatcher.start(log);
        global._signedDocsWatcher = signedWatcher;
        log('[STARTUP] Watcher retour docs signes demarre');
      } catch (eSw) {
        log('[STARTUP] Watcher retour docs signes non demarre (non bloquant): ' + eSw.message);
      }

      // Trace Logos a l'envoi en signature : ecrit la ligne "PEC XX EUR RAC XX
      // EUR envoye pour signature" dans le dossier Logos. Poll MDD
      // /api/desktop/pec-line-pending.
      try {
        const pecLineWatcher = require('./pec-line-watcher');
        pecLineWatcher.start(log);
        global._pecLineWatcher = pecLineWatcher;
        log('[STARTUP] Watcher ligne PEC signature demarre');
      } catch (ePl) {
        log('[STARTUP] Watcher ligne PEC non demarre (non bloquant): ' + ePl.message);
      }

      // Module TRUST — voie Logos : surveille le dossier SESAM/FSE. A chaque
      // nouvelle FSE avec un acte du jour, retrouve le patient (NIR -> CIVIL.FIC)
      // et POST vers submit-patient (source=logosw). Le SERVEUR applique le
      // garde-fou trigger (n'envoie que si le cabinet a trigger=logosw) + tous
      // les filtres (cooldown, max/RDV...). Rien n'est envoye tant que le trigger
      // n'est pas regle sur "logosw" cote reglages du cabinet.
      try {
        const fseWatcher = require('./fse-watcher');
        fseWatcher.setLogger(log);
        fseWatcher.start(() => {
          const c = require('./config-manager').getConfig() || {};
          return {
            patientsDir: c.logosPatientsDir || null,
            logosIniPath: c.logosIniPath || null,
            apiKey: c.apiKey || '',
            siteUrl: (c.urls && c.urls.site) || CONFIG.siteUrl,
          };
        });
        global._fseWatcher = fseWatcher;
        log('[STARTUP] Watcher FSE->Trust demarre');
      } catch (eFse) {
        log('[STARTUP] Watcher FSE->Trust non demarre (non bloquant): ' + eFse.message);
      }

      // Bouton flottant "Questionnaire MD" sur la page Etat civil de Logos :
      // au clic, envoie un questionnaire medical sur la TABLETTE du cabinet
      // (meme flux que l'extension : POST /api/questionnaire/enqueue, source
      // logos + n° dossier pour le retour dans Logos).
      try {
        const overlayFiche = require('./overlay-fiche');
        overlayFiche.setLogger(log);
        overlayFiche.startOverlay(async (fiche) => {
          // fiche = { nom, prenom, numero, dob(JJ/MM/AAAA) }
          const c = require('./config-manager').getConfig() || {};
          const apiKey = c.apiKey || '';
          if (!apiKey) {
            // Poste non appairé -> on ouvre la fenêtre de connexion pour coller la clé.
            log('[QUESTIONNAIRE] Poste non appairé -> ouverture de la fenêtre de connexion');
            try { openConnectWindow(); } catch (e) {}
            return { ok: false, error: 'not-paired' };
          }
          // Garde-fou : poste en attente/refusé -> en veille, pas d'envoi tablette.
          if (require('./poste-gate').isBlocked()) {
            log('[QUESTIONNAIRE] Poste en attente de validation -> envoi bloqué');
            require('./block-popup').show({
              tone: 'info',
              heading: "Poste en attente de validation",
              message: "Ce poste doit être approuvé par votre administrateur (superadmin › Postes Logos) avant d'envoyer un questionnaire.",
              phone: supportPhone(),
            });
            return { ok: false, error: 'pending-approval' };
          }
          const site = CONFIG.siteUrl; // routes /api/questionnaire/* sur le host MDD
          const patientsDir = c.logosPatientsDir || null;
          let email = null, phone = null, civility = null, dob = fiche.dob || null;
          try {
            if (patientsDir && fiche.numero) {
              const civ = require('./logos-civil-reader').readPatientCivil(patientsDir, fiche.numero, {
                expectedNom: fiche.nom, expectedPrenom: fiche.prenom,
              });
              if (civ) {
                email = civ.email || null;
                phone = civ.portable || null;
                if (!dob && civ.dateNaissance) dob = civ.dateNaissance;
                const cr = String(civ.civilite || '').toLowerCase();
                civility = (cr.startsWith('mme') || cr === 'madame') ? 'mme' : (cr.startsWith('m') ? 'm' : null);
              }
            }
          } catch (eCiv) { log('[QUESTIONNAIRE] lecture patient echouee: ' + eCiv.message); }
          const payload = {
            patient: { nom: fiche.nom, prenom: fiche.prenom, dateNaissance: dob, email, phone, civility },
            sourceSystem: 'logos',
            sourcePatientRef: fiche.numero != null ? String(fiche.numero) : null,
          };
          try {
            const fetch = require('node-fetch');
            const res = await fetch(`${site}/api/questionnaire/enqueue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
              body: JSON.stringify(payload),
            });
            const j = await res.json().catch(() => ({}));
            if (res.ok && j && j.ok) {
              log('[QUESTIONNAIRE] envoye sur la tablette (queue=' + (j.queueId || '?') + ', patient ' + fiche.nom + ')');
              return { ok: true };
            }
            log('[QUESTIONNAIRE] echec envoi: ' + (j.error || ('HTTP ' + res.status)));
            return { ok: false, error: j.error || ('HTTP ' + res.status) };
          } catch (ePost) {
            log('[QUESTIONNAIRE] exception envoi: ' + ePost.message);
            return { ok: false, error: ePost.message };
          }
        });
        global._overlayFiche = overlayFiche;
        log('[STARTUP] Overlay Questionnaire MD (fiche) demarre');
      } catch (eFiche) {
        log('[STARTUP] Overlay Questionnaire MD non demarre (non bloquant): ' + eFiche.message);
      }

      // Retour des questionnaires remplis : reecrit le PDF rempli dans le dossier
      // Logos d'origine (poll /api/desktop/questionnaire-pending?source=logos).
      try {
        const questionnaireWatcher = require('./questionnaire-watcher');
        questionnaireWatcher.start(log);
        global._questionnaireWatcher = questionnaireWatcher;
        log('[STARTUP] Watcher retour questionnaire demarre');
      } catch (eQw) {
        log('[STARTUP] Watcher retour questionnaire non demarre (non bloquant): ' + eQw.message);
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
