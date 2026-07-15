/**
 * Logos CIVIL.FIC reader — lit la fiche patient (identité + coordonnées)
 * directement dans le fichier base de Logos, SANS dépendre de l'écran affiché
 * ni du dossier ouvert.
 *
 * Format reverse-engineered (HFSQL Classic, fichier <patientsDir>/CIVIL.FIC) :
 *   - Enregistrements de longueur FIXE : 2504 octets.
 *   - L'enregistrement d'indice N correspond au patient n°N :
 *       offset(record N) = 2504 * N
 *   - Champs (offsets dans l'enregistrement, encodage ISO-8859-1, padding espaces/nuls) :
 *       +0    nom (patronyme)          ~28
 *       +29   prénom
 *       +61   date naissance (YYYYMMDD)
 *       +70   civilité (Mr/Mme...)
 *       +74   adresse
 *       +115  complément d'adresse
 *       +156  code postal
 *       +164  ville
 *       +336  portable
 *       +355  EMAIL
 *       +456  profession
 *       +627  NIR
 *
 * Validé sur les patients 100, 300, 510, 511, 1000.
 */

const fs = require('fs');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) { const m = `[CIVIL] ${msg}`; if (_logger) _logger(m); else console.log(m); }

const RECORD_LEN = 2504;
const OFF = {
  nom: 0, prenom: 29, dateNaissance: 61, civilite: 70,
  adresse: 74, complement: 115, cp: 156, ville: 164,
  portable: 336, email: 355, profession: 456, nir: 627,
};

// Longueurs de lecture par champ (jusqu'au champ suivant ; on strippe ensuite)
const LEN = {
  nom: 28, prenom: 30, dateNaissance: 8, civilite: 4,
  adresse: 40, complement: 40, cp: 8, ville: 30,
  portable: 18, email: 100, profession: 40, nir: 25,
};

/** Localise le fichier CIVIL.FIC à partir du dossier patients fourni par CabFlowReader. */
function findCivilFic(patientsDir) {
  const candidates = [];
  if (patientsDir) {
    candidates.push(path.join(patientsDir, 'CIVIL.FIC'));
    candidates.push(path.join(patientsDir, 'Patients', 'CIVIL.FIC'));
    candidates.push(path.join(path.dirname(patientsDir), 'CIVIL.FIC'));
  }
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

function decodeField(buf, name) {
  const start = OFF[name];
  const raw = buf.slice(start, start + (LEN[name] || 32));
  // ISO-8859-1, coupe au premier octet nul, strip espaces
  let end = raw.indexOf(0x00);
  if (end === -1) end = raw.length;
  return raw.slice(0, end).toString('latin1').trim();
}

/** Lit un enregistrement patient (2504 octets) par numéro. */
function readRecordByNumber(ficPath, patientNumber) {
  const offset = RECORD_LEN * patientNumber;
  const fd = fs.openSync(ficPath, 'r');
  try {
    const buf = Buffer.alloc(RECORD_LEN);
    const read = fs.readSync(fd, buf, 0, RECORD_LEN, offset);
    if (read < RECORD_LEN) return null;
    return buf;
  } finally { fs.closeSync(fd); }
}

/**
 * Retourne la fiche patient { nom, prenom, dateNaissance, email, portable, nir, ... }
 * à partir du dossier patients + numéro de patient.
 *
 * @param {string} patientsDir - dossier contenant CIVIL.FIC (fourni par CabFlowReader)
 * @param {number|string} patientNumber - numéro du patient (indice d'enregistrement)
 * @param {Object} [opts]
 * @param {string} [opts.expectedNom] - nom attendu, pour valider l'alignement
 * @returns {Object|null}
 */
function readPatientCivil(patientsDir, patientNumber, opts = {}) {
  const ficPath = findCivilFic(patientsDir);
  if (!ficPath) { log('CIVIL.FIC introuvable (patientsDir=' + patientsDir + ')'); return null; }
  const n = parseInt(patientNumber, 10);
  if (!Number.isFinite(n) || n <= 0) { log('numéro patient invalide: ' + patientNumber); return null; }

  let buf = readRecordByNumber(ficPath, n);
  if (!buf) { log('enregistrement ' + n + ' hors fichier'); return null; }

  let rec = {
    nom: decodeField(buf, 'nom'),
    prenom: decodeField(buf, 'prenom'),
    dateNaissance: decodeField(buf, 'dateNaissance'),
    civilite: decodeField(buf, 'civilite'),
    email: decodeField(buf, 'email'),
    portable: decodeField(buf, 'portable'),
    cp: decodeField(buf, 'cp'),
    ville: decodeField(buf, 'ville'),
    nir: decodeField(buf, 'nir').replace(/\s/g, ''),
  };

  // Validation d'alignement : si un nom est attendu et ne correspond pas,
  // on scanne le fichier pour retrouver le bon enregistrement par nom.
  if (opts.expectedNom && rec.nom &&
      rec.nom.toUpperCase() !== opts.expectedNom.toUpperCase()) {
    log(`alignement: rec#${n} nom="${rec.nom}" != attendu "${opts.expectedNom}", scan par nom`);
    const byName = findRecordByName(ficPath, opts.expectedNom, rec.prenom || opts.expectedPrenom);
    if (byName) rec = byName;
  }

  // Sanitise l'email
  if (rec.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rec.email)) rec.email = '';
  log(`patient #${n} "${rec.nom} ${rec.prenom}" email=${rec.email || 'aucun'}`);
  return rec;
}

/** Repli : scanne CIVIL.FIC pour trouver l'enregistrement dont le nom (+ prénom) correspond. */
function findRecordByName(ficPath, nom, prenom) {
  const size = fs.statSync(ficPath).size;
  const total = Math.floor(size / RECORD_LEN);
  const fd = fs.openSync(ficPath, 'r');
  try {
    const buf = Buffer.alloc(RECORD_LEN);
    const N = (nom || '').toUpperCase();
    const P = (prenom || '').toUpperCase();
    for (let i = 1; i < total; i++) {
      fs.readSync(fd, buf, 0, RECORD_LEN, i * RECORD_LEN);
      const recNom = decodeField(buf, 'nom').toUpperCase();
      if (recNom !== N) continue;
      const recPrenom = decodeField(buf, 'prenom').toUpperCase();
      if (P && recPrenom && recPrenom !== P) continue;
      return {
        nom: decodeField(buf, 'nom'), prenom: decodeField(buf, 'prenom'),
        dateNaissance: decodeField(buf, 'dateNaissance'), civilite: decodeField(buf, 'civilite'),
        email: decodeField(buf, 'email'), portable: decodeField(buf, 'portable'),
        cp: decodeField(buf, 'cp'), ville: decodeField(buf, 'ville'),
        nir: decodeField(buf, 'nir').replace(/\s/g, ''),
      };
    }
  } finally { fs.closeSync(fd); }
  return null;
}

module.exports = { setLogger, readPatientCivil, findRecordByName, RECORD_LEN, OFF };
