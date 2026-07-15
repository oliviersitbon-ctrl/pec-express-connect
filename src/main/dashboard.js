/**
 * Dashboard Mon devis dentaire Connecté - fenetre tray + watcher temps reel DLL/Service
 *
 * Initialisation:
 *   const dashboard = require('./dashboard');
 *   dashboard.init({ logger, app });
 *   tray.on('click', dashboard.show);
 *
 * Effets:
 *   - Lazy-create la BrowserWindow seulement au premier show()
 *   - fs.watch sur le dossier native\ pour detecter DLL ajout/suppr en temps reel
 *   - setInterval 3s pour check service status
 *   - Push status au renderer via webContents.send('lc-status-changed')
 *   - Enregistre les IPC handlers (lc-get-status, lc-reinstall-dll, lc-uninstall-all, lc-get-logs)
 */

const { BrowserWindow, ipcMain, app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

let logger = (msg) => console.log('[DASHBOARD] ' + msg);
let isQuittingRef = () => false;
let win = null;
let dllWatcher = null;
let svcInterval = null;
let lastStatusJson = null;

function log(msg) { logger('[DASHBOARD] ' + msg); }

function dllInstalledPath() {
  return path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Mon devis dentaire Connecté', 'resources', 'native', 'cabflow-logos-bridge.dll');
}

function nativeDir() {
  return path.dirname(dllInstalledPath());
}

function backupDllPath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'resources', 'backup', 'cabflow-logos-bridge.dll'),
    path.join(__dirname, '..', '..', 'resources', 'backup', 'cabflow-logos-bridge.dll')
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function readServiceStatus() {
  let installed = false, running = false;
  try {
    const out = execSync('sc query PecExpressService', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    installed = /STATE/.test(out);
    running = /STATE\s*:\s*4\s+RUNNING/.test(out);
  } catch (e) { /* service absent */ }
  return { installed, running };
}

function computeStatus() {
  const dllPath = dllInstalledPath();
  const dllInstalled = fs.existsSync(dllPath);
  const svc = readServiceStatus();
  return {
    version: app.getVersion(),
    dll: { installed: dllInstalled, path: dllPath },
    service: { installed: svc.installed, running: svc.running }
  };
}

function pushStatusIfChanged() {
  const status = computeStatus();
  const json = JSON.stringify(status);
  if (json !== lastStatusJson) {
    lastStatusJson = json;
    if (win && !win.isDestroyed() && win.webContents) {
      try { win.webContents.send('lc-status-changed', status); } catch (e) {}
    }
  }
}

function startWatchers() {
  // Watcher fs sur le dossier native -> ajout/suppr DLL en temps reel
  const dir = nativeDir();
  if (fs.existsSync(dir)) {
    try {
      dllWatcher = fs.watch(dir, (eventType, filename) => {
        if (filename && /cabflow-logos-bridge\.dll/i.test(filename)) {
          log('FS watch event: ' + eventType + ' ' + filename);
          // Petit delai pour laisser fs se stabiliser
          setTimeout(pushStatusIfChanged, 200);
        }
      });
      log('FS watcher actif sur ' + dir);
    } catch (e) {
      log('FS watcher echec: ' + e.message);
    }
  } else {
    log('Dir native introuvable, pas de watcher fs');
  }

  // Poll 3s pour le service (pas d'API event-driven cote Node sur SCM)
  svcInterval = setInterval(pushStatusIfChanged, 3000);
}

function stopWatchers() {
  if (dllWatcher) { try { dllWatcher.close(); } catch {} dllWatcher = null; }
  if (svcInterval) { clearInterval(svcInterval); svcInterval = null; }
}

function createWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 480,
    height: 460,
    show: false,
    title: 'Mon devis dentaire Connecté v' + app.getVersion(),
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '..', 'preload.js')
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'dashboard.html'));

  win.on('ready-to-show', () => {
    // ne pas auto-show ici, c'est show() qui declenche
  });
  // [OPT v1.0.16] Detruire vraiment la fenetre a la fermeture pour liberer le renderer (~100 MB)
  // La fenetre sera recreee a la volee au prochain clic tray
  win.on('closed', () => { win = null; });
  return win;
}

function show() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
  // Force un push immediat au cas ou
  setTimeout(pushStatusIfChanged, 100);
}

function registerIpc() {
  ipcMain.handle('lc-get-status', () => computeStatus());

  ipcMain.handle('lc-reinstall-dll', async () => {
    const dllPath = dllInstalledPath();
    const backup = backupDllPath();
    log('reinstall-dll: backup=' + backup + ' dst=' + dllPath);
    if (!fs.existsSync(backup)) return { ok: false, error: 'Backup DLL introuvable: ' + backup };

    const psInner = `Copy-Item -Path '${backup.replace(/'/g, "''")}' -Destination '${dllPath.replace(/'/g, "''")}' -Force; sc.exe stop PecExpressService | Out-Null; Start-Sleep -Seconds 1; sc.exe start PecExpressService | Out-Null`;
    const encoded = Buffer.from(psInner, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs -Wait"`;
    try {
      execSync(cmd, { timeout: 60000 });
      const ok = fs.existsSync(dllPath);
      pushStatusIfChanged();
      return ok ? { ok: true } : { ok: false, error: 'Copie effectuee mais DLL absente apres' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('lc-uninstall-all', async () => {
    log('uninstall-all demande');
    const pf = (process.env.ProgramFiles || 'C:\\Program Files') + '\\Mon devis dentaire Connecté';
    const psScript = [
      `Stop-Service PecExpressService -Force -ErrorAction SilentlyContinue`,
      `sc.exe delete PecExpressService | Out-Null`,
      `Get-Process 'Mon devis dentaire Connecté','PecExpressService','LOGOS_w' -ErrorAction SilentlyContinue | Stop-Process -Force`,
      `Start-Sleep -Seconds 2`,
      `$u='${pf.replace(/'/g, "''")}\\Uninstall Mon devis dentaire Connecté.exe'; if (Test-Path $u) { Start-Process -FilePath $u -ArgumentList '/S' -Wait; Start-Sleep -Seconds 3 }`,
      `if (Test-Path '${pf.replace(/'/g, "''")}') { takeown /F '${pf.replace(/'/g, "''")}' /R /D O | Out-Null; icacls '${pf.replace(/'/g, "''")}' /grant '*S-1-5-32-544:F' /T /C | Out-Null; Remove-Item '${pf.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue }`,
      `Remove-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name LogosConnect -ErrorAction SilentlyContinue`,
      `Remove-Item 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mon devis dentaire Connecté' -Recurse -Force -ErrorAction SilentlyContinue`,
      `Remove-Item "$env:APPDATA\\logos-connect" -Recurse -Force -ErrorAction SilentlyContinue`,
      `Remove-Item "$env:USERPROFILE\\PecExpress" -Recurse -Force -ErrorAction SilentlyContinue`,
      `Remove-Item 'C:\\ProgramData\\PecExpress' -Recurse -Force -ErrorAction SilentlyContinue`
    ].join('; ');

    const encoded = Buffer.from(psScript, 'utf16le').toString('base64');
    const cmd = `powershell -NoProfile -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}' -Verb RunAs"`;
    try {
      execSync(cmd, { timeout: 10000 });
      setTimeout(() => { app.quit(); }, 1500);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('lc-get-logs', (event, tab) => {
    const userLogs = path.join(os.homedir(), 'PecExpress', 'logs', 'app.log');
    const serviceLog = 'C:\\ProgramData\\PecExpress\\service.log';
    const dllLog = path.join(os.homedir(), 'PecExpress', 'logs', 'dll-bridge.log');

    function readTail(file, label) {
      if (!fs.existsSync(file)) return [];
      try {
        const content = fs.readFileSync(file, 'utf8');
        return content.split('\n').filter(l => l.trim()).slice(-200).map(l => `[${label}] ${l}`);
      } catch { return []; }
    }

    const out = [];
    if (tab === 'service' || tab === 'all') out.push(...readTail(serviceLog, 'SVC'));
    if (tab === 'app' || tab === 'all')     out.push(...readTail(userLogs, 'APP'));
    if (tab === 'dll' || tab === 'all')     out.push(...readTail(dllLog, 'DLL'));
    return out.slice(-500);
  });
}

function init(opts) {
  if (opts && opts.logger) logger = opts.logger;
  if (opts && opts.isQuittingRef) isQuittingRef = opts.isQuittingRef;
  registerIpc();
  startWatchers();
  log('Module initialise');
}

module.exports = { init, show, computeStatus };
