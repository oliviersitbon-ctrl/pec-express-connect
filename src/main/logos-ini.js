'use strict';

/**
 * logos-ini.js — lecture de la config Logos (LOGOS_w.INI) pour rendre la
 * découverte des chemins PORTABLE d'un cabinet à l'autre (rien de hardcodé).
 *
 * On y lit :
 *   - Répertoire_Patients ([Privé])  -> racine des dossiers patients/devis
 *   - GPID_Prats / GPID_Prat ([Privé]) -> code(s) praticien (ex. "OS")
 *
 * Le dossier des FSE se déduit alors : <racine Logos>\<code>\SESAM\FSE
 * (ex. \\PANO\wlogos2\OS\SESAM\FSE), où <racine Logos> = parent de
 * Répertoire_Patients.
 *
 * L'INI est LOCAL (ex. C:\wlogos1\LOGOS_w.INI), pas sur le partage réseau : on le
 * cherche donc sur les lecteurs locaux courants, plus un éventuel chemin fourni
 * (capté depuis MddReader) en priorité.
 */

const fs = require('fs');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(m) { const s = `[LOGOS-INI] ${m}`; if (_logger) _logger(s); else console.log(s); }

/** Cherche LOGOS_w.INI : chemin fourni en priorité, sinon lecteurs/dossiers usuels. */
function findIniPath(hintPath) {
  const candidates = [];
  if (hintPath) candidates.push(hintPath);
  const drives = ['C:', 'D:', 'E:', 'F:'];
  const dirs = ['wlogos1', 'wlogos2', 'wlogos3', 'wlogos', 'wlogosw', 'Logos', 'LOGOS', 'LogosW'];
  for (const d of drives) for (const w of dirs) candidates.push(`${d}\\${w}\\LOGOS_w.INI`);
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (e) {}
  }
  return null;
}

/**
 * Lit l'INI et renvoie { iniPath, patientsDir, codes[], idPoste, nomUtil }.
 * Ne lève jamais.
 *   - idPoste : [RESEAU] IDPOSTE — identifiant unique DE CE poste (attribué par
 *     Logos). Sert à identifier/lister chaque poste (garde-fou d'appairage).
 *   - nomUtil : GPID_NomUtil — nom du praticien courant (affichage/appoint).
 */
function readIni(hintPath) {
  const iniPath = findIniPath(hintPath);
  if (!iniPath) return { iniPath: null, patientsDir: null, codes: [], idPoste: null, nomUtil: null };
  let txt = '';
  try { txt = fs.readFileSync(iniPath).toString('latin1'); }
  catch (e) { log('lecture INI échouée: ' + e.message); return { iniPath, patientsDir: null, codes: [], idPoste: null, nomUtil: null }; }

  // Répertoire_Patients (le « é » accentué est ignoré en matchant sur la fin de clé).
  const mPat = txt.match(/pertoire_Patients\s*=\s*([^\r\n]+)/i);
  const patientsDir = mPat ? mPat[1].trim() : null;

  // Codes praticien : GPID_Prats (liste) puis GPID_Prat (singulier) en secours.
  const codes = [];
  const mPrats = txt.match(/GPID_Prats\s*=\s*([^\r\n]+)/i);
  if (mPrats) for (const c of mPrats[1].split(/[,;]/)) { const s = c.trim(); if (s) codes.push(s); }
  if (!codes.length) {
    const mPrat = txt.match(/GPID_Prat\s*=\s*([^\r\n]+)/i);
    if (mPrat && mPrat[1].trim()) codes.push(mPrat[1].trim());
  }

  // IDPOSTE ([RESEAU]) : identifiant unique de ce poste. Nom praticien courant.
  const mId = txt.match(/^\s*IDPOSTE\s*=\s*([^\r\n]+)/im);
  const idPoste = mId && mId[1].trim() ? mId[1].trim() : null;
  const mNom = txt.match(/GPID_NomUtil\s*=\s*([^\r\n]+)/i);
  const nomUtil = mNom && mNom[1].trim() ? mNom[1].trim() : null;

  return { iniPath, patientsDir, codes, idPoste, nomUtil };
}

/**
 * Déduit les dossiers FSE à partir de l'INI :
 *   <parent(Répertoire_Patients)>\<code>\SESAM\FSE  (un par code praticien)
 *   + <parent>\SESAM\FSE  (layout à plat éventuel)
 * Renvoie { patientsDir, dirs[] } (dirs = ceux qui existent réellement).
 */
function resolveFseDirsFromIni(hintPath) {
  const { patientsDir, codes } = readIni(hintPath);
  const dirs = [];
  if (patientsDir) {
    const root = path.dirname(patientsDir); // ex. \\PANO\wlogos2
    const cands = [path.join(root, 'SESAM', 'FSE')];
    for (const code of codes) cands.push(path.join(root, code, 'SESAM', 'FSE'));
    for (const c of cands) { try { if (fs.existsSync(c)) dirs.push(c); } catch (e) {} }
  }
  return { patientsDir, dirs };
}

module.exports = { setLogger, findIniPath, readIni, resolveFseDirsFromIni };
