/**
 * Logos CIVILORG.MMO parser - extrait la mutuelle (AMC) d'un patient
 *
 * CIVILORG.MMO format (reverse-engineered):
 *   - Contient le XML <Couvertures> directement en raw UTF-8
 *   - Pour chaque patient, peut y avoir plusieurs entrees <Couvertures> historiques
 *     (rafraichissement carte vitale, modification AMC, etc.)
 *   - Une entree <Couvertures> contient:
 *       <AMO ... usuelVitale="..." prenomVitale="..." dateNaissance="..." gnirBeneficiaire="..."/>
 *       <AMC ... numeroAMC="..." numeroAdherent="..." numeroContrat="..." nom="..."/>
 *       (optionnel) <RoutageAnnuaire libamc="..."/>
 *
 * Strategie de match robuste (en cascade):
 *   1. Cherche par NIR si disponible (champ gnirBeneficiaire dans AMO)
 *   2. Sinon/en complement: match par (usuelVitale + prenomVitale + dateNaissance)
 *   3. Pour chaque entree matching, parcours en ordre DECROISSANT d'offset
 *      (la plus recente d'abord) et retient la PREMIERE qui a une <AMC> avec numeroAMC.
 *
 * Pourquoi ne pas juste prendre la derniere occurrence:
 *   Logos peut creer des entrees Couvertures sans AMC (lecture vitale seule). Si on prend
 *   aveuglement la derniere on rate la mutuelle qui est dans une entree plus ancienne.
 */

const fs = require('fs');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[CIVILORG-PARSER] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

function parseXmlAttrs(tagStr) {
  const attrs = {};
  const rx = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = rx.exec(tagStr)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

function normalizeNir(nir) {
  if (!nir) return '';
  return String(nir).replace(/[^0-9]/g, '');
}

/**
 * Convertit une date YYYY-MM-DD, DD/MM/YYYY ou similar en format YYYYMMDD utilise dans CIVILORG.MMO.
 */
function normalizeDate(dateStr) {
  if (!dateStr) return '';
  const onlyDigits = String(dateStr).replace(/[^0-9]/g, '');
  if (onlyDigits.length === 8) {
    // YYYYMMDD ou DDMMYYYY ?
    // Si commence par 19 ou 20 -> YYYYMMDD
    if (/^(19|20)\d{6}$/.test(onlyDigits)) return onlyDigits;
    // Sinon DDMMYYYY -> reorder
    return onlyDigits.slice(4, 8) + onlyDigits.slice(2, 4) + onlyDigits.slice(0, 2);
  }
  return onlyDigits;
}

/**
 * Trouve toutes les balises <Couvertures>...</Couvertures> dans le texte.
 * Retourne un tableau de {start, end} pour chaque entree.
 */
function findAllCouvertures(text) {
  const entries = [];
  const rx = /<Couvertures\s+[^>]*>/g;
  let m;
  while ((m = rx.exec(text)) !== null) {
    const start = m.index;
    const end = text.indexOf('</Couvertures>', start);
    if (end > start && end - start < 50000) {
      entries.push({ start, end: end + 14 });
    }
  }
  return entries;
}

/**
 * Extrait les attributs identite (NIR + nom + prenom + dateNaissance) du tag <AMO> d'une
 * entree Couvertures.
 */
function extractAmoIdentity(entryText) {
  // L'AMO peut etre self-closing (/>) OU avec enfants (>...</AMO>)
  // Forme 1: <AMO ... />
  // Forme 2: <AMO ...><ATDefaut .../></AMO>
  // Forme 3: <AMO ...> (cas tronque)
  const amoMatch = entryText.match(/<AMO\s+([^>]+?)\s*(?:\/>|>)/);
  if (!amoMatch) return null;
  const attrs = parseXmlAttrs(amoMatch[1]);
  return {
    nir: normalizeNir(attrs.gnirBeneficiaire || attrs.nirBeneficiaire || ''),
    nom: (attrs.usuelVitale || '').trim().toUpperCase(),
    prenom: (attrs.prenomVitale || '').trim().toUpperCase(),
    dateNaissance: attrs.dateNaissance || ''
  };
}

/**
 * Extrait les infos AMC d'une entree Couvertures.
 */
function extractAmcFromEntry(entryText) {
  const amcMatch = entryText.match(/<AMC\s+([^>]+?)\s*(?:\/>|>)/);
  if (!amcMatch) return null;
  const attrs = parseXmlAttrs(amcMatch[1]);

  // Si nom absent, cherche dans <RoutageAnnuaire libamc="..."/>
  let nom = attrs.nom || '';
  if (!nom) {
    const routage = entryText.match(/<RoutageAnnuaire\s+[^>]*?libamc="([^"]+)"/);
    if (routage) nom = routage[1];
  }

  return {
    nom: nom,
    numeroAMC: attrs.numeroAMC || '',
    numeroAdherent: attrs.numeroAdherent || '',
    numeroContrat: attrs.numeroContrat || '',
    utilisee: attrs.utilisee === '1',
    tp: attrs.tp || '0',
    typeConvention: attrs.typeConvention || '',
    rawTag: amcMatch[0]
  };
}

/**
 * Determine si une entree Couvertures matche un patient (par NIR ou par (nom+prenom+dateN)).
 */
function entryMatchesPatient(entry, patientNorm) {
  if (!entry) return false;
  // Match par NIR si dispo des deux cotes
  if (patientNorm.nir && entry.nir && patientNorm.nir === entry.nir) return true;
  // Match par (nom + prenom + dateN) - tolerant aux espaces / casse
  if (patientNorm.nom && entry.nom && patientNorm.nom === entry.nom
      && patientNorm.prenom && entry.prenom && patientNorm.prenom === entry.prenom
      && patientNorm.dateNaissance && entry.dateNaissance
      && patientNorm.dateNaissance === entry.dateNaissance) return true;
  return false;
}

/**
 * Fonction principale: trouve la mutuelle d'un patient dans CIVILORG.MMO.
 *
 * @param {string} mmoPath
 * @param {Object} patient - {nir, nom, prenom, dateNaissance} (au moins l'un ou nom+prenom+date)
 * @returns {Object|null}
 */
function findMutuelle(mmoPath, patient) {
  if (!fs.existsSync(mmoPath)) {
    log(`MMO introuvable: ${mmoPath}`);
    return null;
  }
  if (!patient || (!patient.nir && !(patient.nom && patient.prenom && patient.dateNaissance))) {
    log('Patient: il faut au moins un NIR ou (nom + prenom + dateNaissance)');
    return null;
  }

  // Normalise les criteres patient
  const patientNorm = {
    nir: normalizeNir(patient.nir || ''),
    nom: (patient.nom || '').trim().toUpperCase(),
    prenom: (patient.prenom || '').trim().toUpperCase(),
    dateNaissance: normalizeDate(patient.dateNaissance || '')
  };

  const buf = fs.readFileSync(mmoPath);
  const text = buf.toString('utf8');
  log(`MMO=${(buf.length/1024).toFixed(0)}KB, recherche patient nir=${patientNorm.nir} nom=${patientNorm.nom} prenom=${patientNorm.prenom} dob=${patientNorm.dateNaissance}`);

  // Trouve toutes les entrees <Couvertures>
  const entries = findAllCouvertures(text);
  log(`${entries.length} entrees Couvertures trouvees dans le fichier`);

  // Match les entrees qui correspondent a ce patient
  const matching = [];
  for (const e of entries) {
    const entryText = text.substring(e.start, e.end);
    const identity = extractAmoIdentity(entryText);
    if (!identity) continue;
    const idNorm = {
      nir: identity.nir,
      nom: identity.nom,
      prenom: identity.prenom,
      dateNaissance: identity.dateNaissance
    };
    if (entryMatchesPatient(idNorm, patientNorm)) {
      matching.push({ ...e, identity: idNorm, text: entryText });
    }
  }

  if (matching.length === 0) {
    log(`Aucune entree Couvertures matchant ce patient. Probablement pas de mutuelle saisie.`);
    return null;
  }

  log(`${matching.length} entree(s) matching, parcours de la plus recente a la plus ancienne pour trouver l'AMC...`);

  // Parcours en ordre decroissant (la plus recente = offset le plus grand)
  matching.sort((a, b) => b.start - a.start);

  for (const m of matching) {
    // Skip explicitement les entrees marquees sansAMC="1" (lecture vitale seule, pas de mutuelle saisie)
    if (/sansAMC="1"/.test(m.text)) continue;
    const amc = extractAmcFromEntry(m.text);
    // On accepte une entree si elle a au moins UN signal de mutuelle:
    // - numeroAMC (saisie via annuaire amc.lgw, cas standard)
    // - OU nom non vide (saisie libre par le praticien, sans code organisme)
    // - OU numeroAdherent non vide (idem)
    if (amc && (amc.numeroAMC || amc.nom || amc.numeroAdherent || amc.numeroContrat)) {
      // Fallback annuaire AMC: si le nom est vide ou tronque dans CIVILORG.MMO,
      // on tente de le resoudre via amc.lgw (annuaire national des mutuelles)
      if (!amc.nom) {
        try {
          const amcDir = require('./logos-amc-directory');
          amcDir.setLogger(_logger || (() => {}));
          const resolvedName = amcDir.resolveAmcName(amc.numeroAMC);
          if (resolvedName) {
            log(`Nom vide dans CIVILORG.MMO, resolu via annuaire AMC: '${resolvedName}'`);
            amc.nom = resolvedName;
            amc.nomSource = 'directory';
          } else {
            amc.nomSource = 'none';
          }
        } catch (e) {
          log(`Erreur fallback annuaire AMC: ${e.message}`);
        }
      } else {
        amc.nomSource = 'civilorg';
      }
      log(`AMC extrait (Couvertures offset=${m.start}): nom='${amc.nom}' numeroAMC=${amc.numeroAMC} adh=${amc.numeroAdherent} contrat=${amc.numeroContrat}`);
      return amc;
    }
  }

  log(`Aucune des ${matching.length} entree(s) matching n'a de <AMC> avec numeroAMC. Patient sans mutuelle complementaire.`);
  return null;
}

/**
 * Wrapper retro-compatible: ancien appel par NIR seul.
 */
function findMutuelleByNir(mmoPath, nir) {
  return findMutuelle(mmoPath, { nir });
}

module.exports = {
  setLogger,
  findMutuelle,
  findMutuelleByNir,
  normalizeNir,
  normalizeDate,
  extractAmoIdentity,
  extractAmcFromEntry,
  findAllCouvertures
};
