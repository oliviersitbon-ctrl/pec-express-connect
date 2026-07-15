/**
 * Logos MMO Parser - lit le fichier DEVIS.MMO de Logos directement
 *
 * Format reverse-engineered:
 *   - Fichier HFSQL paginé en blocs de 128 bytes
 *   - Chaque bloc commence par 12 bytes de header HFSQL:
 *       [byte byte] = 2 bytes header page
 *       [0x27 0x00 0x74 0x00 0x74 0x00] = signature 'tt (6 bytes)
 *       [4 bytes] = pointer next page
 *   - Reste du bloc = 116 bytes de contenu utile UTF-8
 *
 * Pour reconstituer le XML propre, on lit le fichier MMO depuis l'offset
 * MemoOff du devis, et on strip les 12 bytes de header tous les 128 bytes.
 *
 * Le XML reconstitué contient:
 *   <DevisGraphique ... praticien="YM" nomPatient="X" honorairesG="X"...>
 *     <Schema1>...</Schema1>
 *     <Ligne code="..." dent="..." nom="..." cotation="..." honoraires="..." .../>
 *     <Alternative dent="..." nom="..." cotation="..." rangPt="..."/>
 *   </DevisGraphique>
 */

const fs = require('fs');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[MMO-PARSER] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

const PAGE_SIZE = 128;
const HEADER_SIZE = 12;
const CONTENT_PER_PAGE = PAGE_SIZE - HEADER_SIZE;  // 116

/**
 * Reconstruit le XML clean depuis un buffer MMO en strippant les headers de page.
 * @param {Buffer} buf - le buffer entier du fichier DEVIS.MMO
 * @param {number} startOffset - offset de debut du devis dans le fichier
 * @param {number} maxLen - longueur max a lire (default 100KB)
 * @returns {string} le contenu UTF-8 clean
 */
function stripPageHeaders(buf, startOffset, maxLen = 100000) {
  const out = [];
  let pos = startOffset;
  const end = Math.min(startOffset + maxLen, buf.length);
  while (pos < end) {
    const contentStart = pos + HEADER_SIZE;
    const contentEnd = Math.min(pos + PAGE_SIZE, end);
    for (let i = contentStart; i < contentEnd; i++) {
      out.push(buf[i]);
    }
    pos += PAGE_SIZE;
  }
  return Buffer.from(out).toString('utf8');
}

/**
 * Parse les attributs XML d'une balise type <tag attr1="val1" attr2="val2".../>
 * Renvoie un objet { attr1: 'val1', attr2: 'val2', ... }
 */
function parseXmlAttrs(tagStr) {
  const attrs = {};
  const rx = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = rx.exec(tagStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

/**
 * Parse le XML d'un devis et retourne un objet structure.
 */
function parseDevisXml(xml) {
  const result = {
    metadata: {},
    actes: [],
    alternatives: []
  };

  // Extrait les attributs du tag <DevisGraphique ...>
  const dgMatch = xml.match(/<DevisGraphique\s+([^>]+)>/);
  if (dgMatch) {
    result.metadata = parseXmlAttrs(dgMatch[1]);
  }

  // Extrait tous les <Ligne .../>
  // Regex tolerante: accepte "/" dans les valeurs ("Inlay/onlay"), non-greedy jusqu'a "/>"
  const ligneRx = /<Ligne\s+([^>]+?)\/>/g;
  let m;
  while ((m = ligneRx.exec(xml)) !== null) {
    result.actes.push(parseXmlAttrs(m[1]));
  }

  // Extrait tous les <Alternative .../>
  const altRx = /<Alternative\s+([^>]+?)\/>/g;
  while ((m = altRx.exec(xml)) !== null) {
    result.alternatives.push(parseXmlAttrs(m[1]));
  }

  return result;
}

/**
 * Lit DEVIS.MMO et retourne le XML clean pour un devis donné par son MemoOff.
 */
function readDevisXml(mmoPath, memoOffset) {
  const buf = fs.readFileSync(mmoPath);
  log(`MMO=${(buf.length / 1024).toFixed(0)}KB, lecture devis offset=0x${memoOffset.toString(16)}`);
  const raw = stripPageHeaders(buf, memoOffset, 200000);
  // Trouve le XML
  const startIdx = raw.indexOf('<DevisGraphique');
  const endIdx = raw.indexOf('</DevisGraphique>');
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(`XML DevisGraphique introuvable (start=${startIdx} end=${endIdx})`);
  }
  return raw.substring(startIdx, endIdx + '</DevisGraphique>'.length);
}

/**
 * Parse un fichier DEVIS.FIC pour trouver le dernier devis d'un patient.
 * Format DEVIS.FIC (HFSQL) - structure simplifiée observée:
 *   - 70KB pour ce cabinet
 *   - Chaque ligne devis: patientId (4 bytes) + date (4 bytes) + memoOffset (4 bytes) + ...
 * On va parser pour trouver tous les devis du patientId donné.
 *
 * Pour l'instant on délègue cette partie à CabFlowReader.exe qui sait deja
 * trouver le bon memoOffset, puis on appelle notre parseur clean sur le MMO.
 * (le parsing FIC est plus complexe et hors scope immediat)
 */
function findDevisInFic(ficPath, patientId) {
  // TODO: parser FIC HFSQL natif si besoin
  // En attendant, on utilise CabFlowReader.exe juste pour avoir le memoOffset
  return null;
}

/**
 * Workflow complet: prend patientId, lance CabFlowReader pour identifier le devis,
 * puis reparse le MMO proprement.
 */
function readPatientDevisClean(opts) {
  const {
    patientsDir,  // C:\Users\amzal\OneDrive\Desktop\wlogos2\Patients
    patientId,
    devisId,
    memoOffset    // offset DEVIS.MMO du devis
  } = opts;

  const mmoPath = path.join(patientsDir, 'DEVIS.MMO');
  if (!fs.existsSync(mmoPath)) {
    throw new Error(`DEVIS.MMO non trouve: ${mmoPath}`);
  }

  const xml = readDevisXml(mmoPath, memoOffset);
  log(`XML clean: ${xml.length} chars`);
  const parsed = parseDevisXml(xml);
  log(`Parse: ${parsed.actes.length} actes, ${parsed.alternatives.length} alternatives`);
  parsed.patientId = patientId;
  parsed.devisId = devisId;
  parsed.patientsDir = patientsDir;  // pour readPraticienInfo
  return parsed;
}

/**
 * Transforme le format brut parse en format compatible avec l'URL Mon devis dentaire
 * (compatible avec ce que CabFlowReader produit deja).
 */
function toPecExpressFormat(parsed, civilInfo) {
  const meta = parsed.metadata;
  const actes = parsed.actes.map(a => {
    // Honoraires en number (peut etre "566.5" ou "1565,6")
    const honStr = (a.honoraires || '').replace(',', '.');
    const hon = parseFloat(honStr);
    return {
      dent: a.dent || '',
      ccam: a.cotation || '',
      nom: a.nom || '',
      honoraires: isNaN(hon) ? null : hon,
      base: a.base ? parseFloat(a.base.replace(',', '.')) : null,
      amo: a.amo ? parseFloat(a.amo.replace(',', '.')) : null,
      reste: a.reste ? parseFloat(a.reste.replace(',', '.')) : null,
      materiau: a.mats || '',
      code: a.code || '',
      rangPt: a.rangPt || '',
      rangPr: a.rangPr || ''
    };
  });

  // Resoudre les infos praticien (YM -> Yoram MAMAN avec RPPS, etc.)
  let praticienInfo = null;
  if (meta.praticien && parsed.patientsDir) {
    try { praticienInfo = readPraticienInfo(parsed.patientsDir, meta.praticien); }
    catch (e) { log(`Praticien resolution error: ${e.message}`); }
  }

  return {
    patientId: parsed.patientId,
    devisId: parsed.devisId,
    source: 'DEVIS.MMO (clean)',
    nom: (civilInfo && civilInfo.nom) || meta.nomPatient || '',
    prenom: (civilInfo && civilInfo.prenom) || meta.prenomPatient || '',
    dateNaissance: (civilInfo && civilInfo.dateNaissance) || '',
    nir: (civilInfo && civilInfo.nir) || '',
    praticien: meta.praticien || '',
    praticienInfo,  // objet detaille { nom, prenom, rpps, finess, adeli, raisonSociale }
    date: meta.date || '',
    validite: meta.validite || '',
    honorairesTotal: meta.honorairesG ? parseFloat(meta.honorairesG.replace(',', '.')) : 0,
    baseTotal: meta.baseG ? parseFloat(meta.baseG.replace(',', '.')) : 0,
    amoTotal: meta.amoG ? parseFloat(meta.amoG.replace(',', '.')) : 0,
    resteTotal: meta.resteG ? parseFloat(meta.resteG.replace(',', '.')) : 0,
    actes,
    alternatives: parsed.alternatives
  };
}

/**
 * Lit les infos praticien depuis le fichier INI Logos d'un cabinet
 * Format INI Windows: ANSI/Latin-1 (cp1252) - certains accents non-UTF8
 * Le fichier est typiquement dans <patientsDir>/<initiales>/LOGOS_w.INI
 *
 * Section [Identite] ou direct au top du INI contient:
 *   Nom=MAMAN
 *   Prenom=YORAM
 *   Adeli=10103490412
 *   RPPS=10101340635
 *   FINESS=77471050300
 *   NumerosFacturationUtilises=77471050
 *   Raison_1=SELAS DU DR YORAM MAMAN
 */
function readPraticienInfo(patientsDir, initiales) {
  // Le dossier praticien est typiquement sibling de patientsDir
  // patientsDir = .../wlogos2/Patients donc parent = .../wlogos2 et init dir = .../wlogos2/YM
  const parent = path.dirname(patientsDir);
  const iniPath = path.join(parent, initiales, 'LOGOS_w.INI');
  if (!fs.existsSync(iniPath)) {
    log(`Praticien INI introuvable: ${iniPath}`);
    return null;
  }
  // Lit en latin1 (cp1252)
  const raw = fs.readFileSync(iniPath, 'latin1');
  const get = (key) => {
    const rx = new RegExp(`^${key}\\s*=\\s*(.+?)\\s*$`, 'mi');
    const m = raw.match(rx);
    return m ? m[1].trim() : '';
  };
  const result = {
    initiales,
    nom: get('Nom'),
    prenom: get('Prénom') || get('Prenom') || get('Pr\xe9nom'),
    adeli: get('Adeli'),
    rpps: get('RPPS'),
    finess: get('FINESS'),
    numFacturation: get('NumerosFacturationUtilises'),
    raisonSociale: get('Raison_1')
  };
  log(`Praticien ${initiales}: ${result.prenom} ${result.nom} RPPS=${result.rpps} ADELI=${result.adeli}`);
  return result;
}

module.exports = {
  setLogger,
  stripPageHeaders,
  parseDevisXml,
  readDevisXml,
  readPatientDevisClean,
  toPecExpressFormat,
  readPraticienInfo
};
