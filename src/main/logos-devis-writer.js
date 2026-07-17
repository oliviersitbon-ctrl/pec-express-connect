/**
 * logos-devis-writer.js
 * Ecrit un document signe (devis / consentement) dans le dossier patient Logos,
 * en appelant LogosDevisWriter.exe (WinDev) : pose le PDF dans LIENS\<patient>\
 * puis cree l'ecriture "document" dans ACTES_2 (champ EXTRA, TYPE_DOC=11).
 *
 * L'exe est headless et referme le fichier (HClose) immediatement : Logos peut
 * rester ouvert.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(m) { const s = `[LOGOS-WRITER] ${m}`; if (_logger) _logger(s); else console.log(s); }

const { getConfig } = require('./config-manager');
// Racine data Logos decouverte par CabFlow (UNC \\PANO\wlogos2\Patients chez OS,
// lettre ou UNC ailleurs), memorisee en config. Repli L:\Patients (historique).
function patientsRoot() {
  try {
    const d = (getConfig() || {}).logosPatientsDir;
    if (d && String(d).trim()) return String(d).trim().replace(/[\\/]+$/, '');
  } catch (e) {}
  return 'L:\\Patients';
}
const RESULT_FILE = 'C:\\ProgramData\\PecExpress\\logos-write-result.txt';

function exePath() {
  const candidates = [
    // surcharge explicite (test / poste specifique)
    process.env.LOGOS_WRITER_EXE || null,
    // en prod (app installee) : bundle dans resources/native
    process.resourcesPath ? path.join(process.resourcesPath, 'native', 'LogosDevisWriter.exe') : null,
    // en dev (depuis le repo) : bundle dans resources/native
    path.join(__dirname, '..', '..', 'resources', 'native', 'LogosDevisWriter.exe'),
    // emplacement de compilation WinDev valide (l'exe tourne avec son runtime a cote)
    'C:\\Mes Projets\\Mon_Projet\\Exe\\LogosDevisWriter.exe',
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];
}

/**
 * @param {number|string} patientId  NUMERO du dossier patient Logos
 * @param {Buffer} pdfBuffer         contenu binaire du PDF signe
 * @param {string} filename          nom du fichier (ex: "Devis-signe-1234.pdf")
 * @param {string} label             libelle affiche dans Logos (ex: "Devis signé")
 * @param {string} [praticien="OS"]  initiales praticien
 * @returns {Promise<{ok:boolean, cle?:string, result:string}>}
 */
function writeSignedDoc(patientId, pdfBuffer, filename, label, praticien = 'OS') {
  return new Promise((resolve, reject) => {
    try {
      const num  = String(patientId);
      const root = patientsRoot();
      // 1) poser le PDF dans <root>\LIENS\<patient>\
      const dir = path.join(root, 'LIENS', num);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, filename), pdfBuffer);
      log(`PDF pose: ${path.join(dir, filename)} (${pdfBuffer.length} o)`);

      // 2) appeler l'exe WinDev, en lui passant le dossier data en 5e argument
      const exe = exePath();
      log(`Appel: ${exe} ${num} "${filename}" "${label}" ${praticien} "${root}"`);
      execFile(exe, [num, filename, label, praticien, root], { windowsHide: true }, (err) => {
        let result = '';
        try { result = fs.readFileSync(RESULT_FILE, 'utf8').trim(); } catch (e) {}
        if (err) { log(`Erreur execFile: ${err.message}`); return reject(err); }
        const ok = /^OK/i.test(result);
        const m = result.match(/cle=(\d+)/i);
        log(`Resultat exe: ${result}`);
        resolve({ ok, cle: m ? m[1] : undefined, result });
      });
    } catch (e) {
      log(`Exception: ${e.message}`);
      reject(e);
    }
  });
}

module.exports = { setLogger, writeSignedDoc };
