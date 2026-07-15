/**
 * Spool Parser - Capture des fichiers spool Windows en temps reel
 *
 * Surveille C:\Windows\System32\spool\PRINTERS\ et capture les fichiers .SPL
 * au format EMFSPOOL (header 00 00 01 00) produits par les imprimantes GDI.
 *
 * Double mecanisme: fs.watch (temps reel) + scan periodique (filet de securite)
 * Callback onCapture pour declencher le traitement immediatement.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { isEmfSpoolFormat } = require('./emfspool-parser');
const { isXpsSpoolFormat } = require('./xps-parser');
const { isPostScriptFormat } = require('./ps-to-pdf');

// Logger injectable
let _logger = null;
function setLogger(loggerFn) {
  _logger = loggerFn;
}
function log(message) {
  const msg = `[SPOOL] ${message}`;
  if (_logger) _logger(msg);
  else console.log(msg);
}

// Stockage du dernier SPL capture
let _lastCapturedSpl = null;  // { buffer, capturedAt, name, format }
let _spoolWatchers = []; // array of fs.FSWatcher
let _spoolScanInterval = null;
let _onCapture = null;
const _capturedFiles = new Set(); // deduplication
const _ignoredAtStartup = new Set(); // Fichiers preexistants a IGNORER pour toujours
const _pendingSizes = new Map(); // attente fichier stable (size en cours d'ecriture)
let _startupTime = 0;

/**
 * Enregistre un callback appele quand un SPL EMFSPOOL est capture
 */
function setOnCapture(callback) {
  _onCapture = callback;
}

/**
 * Retourne le chemin du dossier spool Windows
 */
function getSpoolDir() {
  return path.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32', 'spool', 'PRINTERS'
  );
}

/**
 * Retourne TOUS les dossiers a surveiller:
 * - Windows spool natif (pour SPL EMFSPOOL/XPS legacy)
 * - C:\ProgramData\PecExpress\spool\ (pour PS de l'imprimante virtuelle PostScript)
 */
function getAllSpoolDirs() {
  return [
    getSpoolDir(),
    'C:\\ProgramData\\PecExpress\\spool'
  ];
}

/**
 * Tente de capturer un fichier spool (.SPL Windows OU .ps custom PecExpress)
 */
function tryCaptureSpl(fullPath, filename, source) {
  const lower = filename.toLowerCase();
  if (!lower.endsWith('.spl') && !lower.endsWith('.ps') && !lower.endsWith('.prn')) return;

  // Fichiers preexistants au demarrage: ignorer definitivement pour ne pas
  // retraiter des vieux jobs d'impression abandonnes
  if (_ignoredAtStartup.has(filename)) return;

  try {
    if (!fs.existsSync(fullPath)) return;
    const stats = fs.statSync(fullPath);
    if (stats.size < 100) return;

    // Filet de securite: si le fichier a ete cree AVANT le demarrage d'Mon devis dentaire,
    // il ne nous concerne pas (impression anterieure)
    if (_startupTime > 0 && stats.mtimeMs < _startupTime - 1000) {
      _ignoredAtStartup.add(filename);
      return;
    }

    // Pour les .ps (imprimante virtuelle), attendre que le fichier soit COMPLET:
    // verifier que la taille ne change plus depuis au moins 250ms.
    // Sinon GS plante sur PS incomplet.
    if (lower.endsWith('.ps')) {
      const prevSize = _pendingSizes.get(filename);
      if (prevSize === undefined || prevSize !== stats.size) {
        _pendingSizes.set(filename, stats.size);
        // Reverifier dans 300ms
        setTimeout(() => {
          try {
            if (!fs.existsSync(fullPath)) return;
            const newStats = fs.statSync(fullPath);
            if (newStats.size === stats.size) {
              tryCaptureSpl(fullPath, filename, source + '-stable');
            }
          } catch (e) {}
        }, 300);
        return;
      }
      _pendingSizes.delete(filename);
    }

    // Deduplication par nom+taille+mtime: si le fichier change (nouveau job d'impression
    // ecrasant le precedent fichier de meme nom/taille), on retraite.
    const fileKey = `${filename}:${stats.size}:${stats.mtimeMs}`;
    if (_capturedFiles.has(fileKey)) return;

    // Lire le buffer
    let buffer = null;

    // Methode 1: copie temp
    const tempPath = path.join(os.tmpdir(), `cabflow-spl-${Date.now()}.bin`);
    try {
      fs.copyFileSync(fullPath, tempPath);
      buffer = fs.readFileSync(tempPath);
      fs.unlinkSync(tempPath);
    } catch (copyErr) {
      // Methode 2: lecture directe
      try {
        buffer = fs.readFileSync(fullPath);
      } catch (readErr) {
        log(`[${source}] SPL non lisible: ${filename} - ${readErr.message}`);
        return;
      }
      try { fs.unlinkSync(tempPath); } catch (e) { /* ignore */ }
    }

    if (!buffer || buffer.length < 100) return;

    // Detecter le format (PS prioritaire pour la nouvelle imprimante virtuelle)
    const isPs = isPostScriptFormat(buffer);
    const isEmf = !isPs && isEmfSpoolFormat(buffer);
    const isXps = !isPs && !isEmf && isXpsSpoolFormat(buffer);

    if (isPs || isEmf || isXps) {
      _capturedFiles.add(fileKey);
      const format = isPs ? 'postscript' : (isEmf ? 'emfspool' : 'xps');
      const captured = {
        buffer,
        capturedAt: Date.now(),
        name: filename,
        size: buffer.length,
        format
      };
      _lastCapturedSpl = captured;
      log(`[${source}] ${format.toUpperCase()} capture: ${filename} (${(buffer.length / 1024).toFixed(1)} KB)`);

      // Declencher le callback
      if (_onCapture) {
        _onCapture(captured);
      }
    } else {
      log(`[${source}] SPL ignore: ${filename} (${buffer.length} bytes, header: ${buffer.slice(0, 4).toString('hex')})`);
    }
  } catch (e) {
    // Fichier deja supprime ou inaccessible
  }
}

/**
 * Demarre la surveillance des dossiers spool (Windows + PecExpress PS).
 * Double mecanisme: fs.watch + scan periodique toutes les 3 secondes.
 */
function startSpoolWatcher() {
  if (_spoolWatchers.length > 0) {
    log('Watchers spool deja actifs');
    return;
  }

  const dirs = getAllSpoolDirs();
  const eligibleExts = ['.spl', '.ps', '.prn'];
  _startupTime = Date.now();

  for (const spoolDir of dirs) {
    if (!fs.existsSync(spoolDir)) {
      try { fs.mkdirSync(spoolDir, { recursive: true }); }
      catch (e) { log(`Dossier ${spoolDir} inexistant et impossible a creer: ${e.message}`); continue; }
    }

    log(`Demarrage surveillance: ${spoolDir}`);

    try {
      const watcher = fs.watch(spoolDir, (eventType, filename) => {
        if (!filename) return;
        const lower = filename.toLowerCase();
        if (!eligibleExts.some(e => lower.endsWith(e))) return;
        const fullPath = path.join(spoolDir, filename);
        const t0 = Date.now();
        try {
          const exists = fs.existsSync(fullPath);
          const size = exists ? fs.statSync(fullPath).size : 0;
          log(`[WATCH] ${path.basename(spoolDir)} t=0 | type=${eventType} | file=${filename} | size=${size}`);
        } catch(e) {}

        tryCaptureSpl(fullPath, filename, 'WATCH');
        setTimeout(() => tryCaptureSpl(fullPath, filename, 'WATCH-300ms'), 300);
        setTimeout(() => tryCaptureSpl(fullPath, filename, 'WATCH-1s'), 1000);
        setTimeout(() => tryCaptureSpl(fullPath, filename, 'WATCH-3s'), 3000);
      });
      watcher.on('error', (err) => log('Watcher error sur ' + spoolDir + ': ' + err.message));
      _spoolWatchers.push(watcher);

      // Marquer fichiers preexistants comme IGNORES (jobs anterieurs)
      try {
        const files = fs.readdirSync(spoolDir);
        const eligible = files.filter(f => eligibleExts.some(e => f.toLowerCase().endsWith(e)));
        for (const f of eligible) _ignoredAtStartup.add(f);
        if (eligible.length > 0) log(`${eligible.length} fichier(s) preexistant(s) IGNORE(S) dans ${spoolDir}`);
      } catch (e) {}
    } catch (e) {
      log(`Erreur surveillance ${spoolDir}: ${e.message}`);
    }
  }

  // Scan periodique global (filet de securite)
  _spoolScanInterval = setInterval(() => {
    for (const dir of dirs) {
      try {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir);
        const eligible = files.filter(f => eligibleExts.some(e => f.toLowerCase().endsWith(e)));
        for (const f of eligible) tryCaptureSpl(path.join(dir, f), f, 'SCAN');
      } catch (e) {}
    }
  }, 3000);

  log(`Watchers spool demarres: ${_spoolWatchers.length} dossier(s)`);
}

/**
 * Arrete tous les watchers spool
 */
function stopSpoolWatcher() {
  for (const w of _spoolWatchers) {
    try { w.close(); } catch (e) {}
  }
  _spoolWatchers = [];
  if (_spoolScanInterval) {
    clearInterval(_spoolScanInterval);
    _spoolScanInterval = null;
  }
  log('Watchers spool arretes - ' + _capturedFiles.size + ' fichier(s) captures');
}

/**
 * Retourne le dernier SPL capture
 */
function getLastCapturedSpl(maxAgeMs = 60000) {
  if (!_lastCapturedSpl) return null;
  const age = Date.now() - _lastCapturedSpl.capturedAt;
  if (age > maxAgeMs) {
    _lastCapturedSpl = null;
    return null;
  }
  return _lastCapturedSpl;
}

/**
 * Attend qu'un SPL soit capture (polling)
 */
async function waitForCapturedSpl(timeoutMs = 10000, intervalMs = 300) {
  const start = Date.now();
  const captureThreshold = start - 30000;

  while (Date.now() - start < timeoutMs) {
    if (_lastCapturedSpl && _lastCapturedSpl.capturedAt > captureThreshold) {
      return _lastCapturedSpl;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  log(`Timeout: aucun SPL capture apres ${timeoutMs / 1000}s`);
  return null;
}

/**
 * Consomme le SPL capture (le retourne et le supprime du cache)
 */
function consumeCapturedSpl() {
  const spl = _lastCapturedSpl;
  _lastCapturedSpl = null;
  return spl;
}

/**
 * Verifie si un buffer est au format XPS (ZIP)
 */
function isXpsFormat(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

module.exports = {
  setLogger,
  setOnCapture,
  startSpoolWatcher,
  stopSpoolWatcher,
  getLastCapturedSpl,
  waitForCapturedSpl,
  consumeCapturedSpl,
  isXpsFormat
};
