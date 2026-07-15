/**
 * Logos Watcher - VRAIE detection evenementielle (zero polling)
 *
 * Utilise WMI Win32_ProcessStartTrace + Win32_ProcessStopTrace pour etre
 * notifie INSTANTANEMENT par Windows quand un process LOGOS_w.exe demarre
 * ou se ferme. Aucun polling, aucun timer.
 *
 * Flux:
 *  - PecExpress Desktop demarre -> startWatcher() lance un sous-process PowerShell
 *    qui s'abonne aux WMI events
 *  - Quand LOGOS_w.exe demarre: PowerShell ecrit "STARTED <PID>" sur stdout
 *    -> PecExpress injecte la DLL dans ce PID
 *  - Quand LOGOS_w.exe s'arrete: PowerShell ecrit "STOPPED <PID>" sur stdout
 *    -> PecExpress nettoie son etat
 *  - PecExpress Desktop ferme -> stopWatcher() tue le sous-process
 *
 * Au demarrage on fait UN scan initial pour catcher un Logos deja lance
 * (Windows ne nous donne pas d'evenement retroactif).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[LOGOS-WATCH] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

let _wmiProcess = null;
let _injectedPids = new Set();

function findInjectorAndDll() {
  // Apres install electron-builder, les fichiers natifs sont sous resources/native/
  // Avant install (dev), ils sont sous native/logos-bridge/build/
  const candidates = [
    path.join(process.resourcesPath || '', 'native'),                    // build installe
    path.join(path.dirname(process.execPath), 'resources', 'native'),    // build installe alt
    path.join(__dirname, '..', '..', 'native', 'logos-bridge', 'build'), // dev local
    path.join(process.resourcesPath || '', 'resources', 'win'),          // legacy
    path.join(__dirname, '..', '..', 'resources', 'win'),                // legacy dev
  ];
  for (const dir of candidates) {
    const inj = path.join(dir, 'cabflow-logos-injector.exe');
    const dll = path.join(dir, 'cabflow-logos-bridge.dll');
    try {
      if (fs.existsSync(inj) && fs.existsSync(dll)) {
        return { injector: inj, dll };
      }
    } catch (e) {}
  }
  return null;
}

/**
 * Injecte la DLL dans un PID donne (appel one-shot, pas de polling)
 */
function injectInto(pid, paths) {
  return new Promise((resolve) => {
    log(`Injection dans PID ${pid}...`);
    const proc = spawn(paths.injector, [String(pid), paths.dll], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    const timeout = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(false); }, 15000);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        log(`Injection OK pid=${pid}`);
        _injectedPids.add(pid);
        resolve(true);
      } else {
        log(`Injection echec pid=${pid} code=${code}`);
        if (stdout.trim()) log(`  stdout: ${stdout.trim()}`);
        if (stderr.trim()) log(`  stderr: ${stderr.trim()}`);
        resolve(false);
      }
    });
    proc.on('error', e => {
      clearTimeout(timeout);
      log('Injecteur spawn error: ' + e.message);
      resolve(false);
    });
  });
}

/**
 * Scan initial UNIQUE pour catcher un Logos deja lance avant PecExpress
 */
function scanCurrentLogos() {
  return new Promise((resolve) => {
    const proc = spawn('tasklist.exe', ['/FI', 'IMAGENAME eq LOGOS_w.exe', '/FO', 'CSV', '/NH'], {
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let out = '';
    proc.stdout.on('data', d => { out += d.toString('utf8'); });
    proc.on('close', () => {
      const pids = [];
      for (const line of out.split('\n')) {
        const m = line.match(/"LOGOS_w\.exe","(\d+)"/);
        if (m) pids.push(parseInt(m[1], 10));
      }
      resolve(pids);
    });
    proc.on('error', () => resolve([]));
  });
}

/**
 * Lance le sous-process PowerShell qui ecoute les WMI events
 * Win32_ProcessStartTrace et Win32_ProcessStopTrace pour LOGOS_w.exe.
 *
 * Stdout du sous-process: lignes "STARTED <PID>" ou "STOPPED <PID>"
 */
function startWmiListener(paths) {
  const psScript = `
$query = "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName = 'LOGOS_w.exe'"
$queryStop = "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName = 'LOGOS_w.exe'"
try {
  Register-WmiEvent -Query $query -SourceIdentifier "PecExpressLogosStart" -ErrorAction Stop
  Register-WmiEvent -Query $queryStop -SourceIdentifier "PecExpressLogosStop" -ErrorAction Stop
} catch {
  Write-Output "WMI_ERROR:$($_.Exception.Message)"
  exit 1
}
Write-Output "WMI_READY"
while ($true) {
  $ev = Wait-Event -Timeout 3600
  if ($ev -eq $null) { continue }
  $name = $ev.SourceIdentifier
  $proc = $ev.SourceEventArgs.NewEvent
  $procId = $proc.ProcessID
  if ($name -eq "PecExpressLogosStart") {
    Write-Output "STARTED $procId"
  } elseif ($name -eq "PecExpressLogosStop") {
    Write-Output "STOPPED $procId"
  }
  Remove-Event -EventIdentifier $ev.EventIdentifier
}
`.trim();

  _wmiProcess = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });

  let buffer = '';
  _wmiProcess.stdout.on('data', async (data) => {
    buffer += data.toString('utf8');
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;

      if (line === 'WMI_READY') {
        log('WMI listener ACTIF (Win32_ProcessStartTrace + StopTrace pour LOGOS_w.exe)');
        log('Aucun polling - Windows notifiera des qu\'un LOGOS_w.exe demarre');
        continue;
      }
      if (line.startsWith('WMI_ERROR')) {
        log('ERREUR WMI: ' + line);
        continue;
      }
      if (line.startsWith('STARTED ')) {
        const pid = parseInt(line.substring(8), 10);
        if (pid && !_injectedPids.has(pid)) {
          log(`>>> LOGOS_w DEMARRE PID=${pid} (notif WMI instantanee) <<<`);
          await injectInto(pid, paths);
        }
        continue;
      }
      if (line.startsWith('STOPPED ')) {
        const pid = parseInt(line.substring(8), 10);
        log(`>>> LOGOS_w FERME PID=${pid} <<<`);
        _injectedPids.delete(pid);
        continue;
      }
    }
  });

  _wmiProcess.stderr.on('data', (data) => {
    const m = data.toString('utf8').trim();
    if (m) log('WMI stderr: ' + m.slice(0, 200));
  });

  _wmiProcess.on('exit', (code) => {
    log('WMI listener termine code=' + code);
    _wmiProcess = null;
  });

  log('WMI listener demarre');
}

async function startWatcher() {
  if (_wmiProcess) {
    log('Watcher deja actif');
    return;
  }
  const paths = findInjectorAndDll();
  if (!paths) {
    log('DLL Logos non disponible. Watcher INACTIF. Pipeline PDF utilisable.');
    return;
  }
  log('=== Watcher Logos EVENTIEL (zero polling) demarre ===');
  log(`  Injector: ${paths.injector}`);
  log(`  DLL: ${paths.dll}`);

  // 1. Scan initial unique pour catcher un Logos deja lance
  const existing = await scanCurrentLogos();
  if (existing.length > 0) {
    log(`Scan initial: ${existing.length} Logos deja lance(s) [${existing.join(',')}]`);
    for (const pid of existing) {
      await injectInto(pid, paths);
    }
  } else {
    log('Scan initial: pas de Logos lance, on attend WMI...');
  }

  // 2. Lancer le listener WMI eventiel (zero polling apres ca)
  startWmiListener(paths);
}

function stopWatcher() {
  if (_wmiProcess) {
    try { _wmiProcess.kill(); } catch (e) {}
    _wmiProcess = null;
  }
  _injectedPids.clear();
  log('Watcher arrete');
}

module.exports = { setLogger, startWatcher, stopWatcher };
