/**
 * Devis Parser - Extrait les données structurées d'un devis dentaire
 * à partir des lignes de texte extraites du fichier XPS/EMFSPOOL.
 *
 * Retourne les données prêtes à être envoyées à app.mondevisdentaire.com/prises-en-charge/nouvelle
 */

// Mapping des codes panier (numéros dans le tableau Logos → labels Mon devis dentaire)
const PANIER_MAP = {
  '1': 'RAC0',
  '2': 'modéré',
  '3': 'libre',
  '4': 'CSS'
};

// Mapping des codes matériaux (légende du devis réglementaire)
const MATERIAU_MAP = {
  '1': 'Alliage précieux',
  '2': 'Alliage non précieux',
  '3': 'Céramo-céramique',
  '4': 'Céramique céramométallique',
  '5': 'Polymères de base',
  '6': 'Dents artificielles'
};

/**
 * Nettoie un montant extrait du texte : "1 236,00" → "1236.00"
 */
function parseMontant(str) {
  if (!str) return '0.00';
  return str.replace(/\s/g, '').replace(',', '.');
}

/**
 * Extrait le nom et prénom depuis une ligne "Nom et prénom : DUPONT Jean"
 */
function parseNomPrenom(line) {
  const match = line.match(/Nom et pr[eé]nom\s*:\s*([A-ZÀ-Ü\-']+)\s+(.+)/i);
  if (!match) return null;
  return { nom: match[1].trim(), prenom: match[2].trim() };
}

/**
 * Extrait la date de naissance depuis "Date de naissance : 31/03/1986"
 */
function parseDateNaissance(line) {
  const match = line.match(/Date de naissance\s*:\s*(\d{2}\/\d{2}\/\d{4})/);
  return match ? match[1] : null;
}

/**
 * Extrait le NIR depuis "N° de sécurité sociale du patient : 2 86 03 93 029 095 18"
 */
function parseNIR(line) {
  const match = line.match(/N°\s*de\s*s[eé]curit[eé]\s*sociale[^:]*:\s*([\d\s]+)/i);
  if (!match) return null;
  const nir = match[1].replace(/\s/g, '');
  return nir.length >= 13 ? nir : null;
}

/**
 * Détecte si une ligne contient un code CCAM (ex: HBLD332, HBLD131)
 */
function hasCCAM(line) {
  return /\b[A-Z]{4}\d{3}\b/.test(line);
}

/**
 * Parse une ligne d'acte du tableau de devis
 * Format attendu: "1 13 14 15 HBLD332 Prothèse définitive châssis métallique 4 dents 2 5 6 2 1 236,00 1 236,00 204,25 122,55 1 113,45"
 * Suivi éventuellement d'une ligne de dents supplémentaires: "16"
 */
function parseActeLine(line, nextLine) {
  // Extraire le code CCAM
  const ccamMatch = line.match(/\b([A-Z]{4}\d{3})\b/);
  if (!ccamMatch) return null;
  const codeCcam = ccamMatch[1];

  // Extraire les numéros de dents AVANT le code CCAM
  const beforeCcam = line.substring(0, line.indexOf(codeCcam));
  const dentNumbers = beforeCcam.match(/\b(\d{1,2})\b/g) || [];
  // Le premier chiffre est le N° de traitement, les suivants sont les dents (11-85)
  const dents = dentNumbers.slice(1).filter(d => parseInt(d) >= 11 && parseInt(d) <= 85);

  // Si la ligne suivante contient uniquement des numéros de dents supplémentaires
  if (nextLine && /^\d{1,2}(\s+\d{1,2})*$/.test(nextLine.trim())) {
    const extraDents = nextLine.trim().split(/\s+/).filter(d => parseInt(d) >= 11 && parseInt(d) <= 85);
    dents.push(...extraDents);
  }

  // Texte après le code CCAM, nettoyé des mots-bruit (Aucun/oui/non = entente préalable)
  const afterCcam = line.substring(line.indexOf(codeCcam) + codeCcam.length);
  const cleaned = afterCcam.replace(/\s+\b(Aucun|oui|non)\b/gi, '').trim();

  // Regex pour les montants : jamais de préfixe millier ambigu (ex: "3 120,00" = panier+montant, PAS 3120€)
  // Les montants ≥ 1000 sur une ligne multi-actes sont couverts par la ligne TOTAL pour acte unique.
  const amountRe = /\b(\d{1,3},\d{2})\b/g;

  // Trouver TOUS les montants de gauche à droite
  const allAmounts = [];
  let amtMatch;
  while ((amtMatch = amountRe.exec(cleaned)) !== null) {
    allAmounts.push(parseMontant(amtMatch[1]));
  }

  // Tout ce qui précède le premier montant = nature + codes matériaux/panier
  const firstAmtPos = cleaned.search(/\b\d{1,3},\d{2}\b/);
  const beforeAmounts = (firstAmtPos >= 0 ? cleaned.substring(0, firstAmtPos) : cleaned).trim();

  // Séparer nature (texte avec lettres) des codes numériques (matériaux, panier)
  const splitMatch = beforeAmounts.match(/^(.*[a-zA-ZÀ-ÿ])\s+([\d\s]+)\s*$/);
  let natureActe = '';
  let materiauLabel = '';
  let panierLabel = '';

  if (splitMatch) {
    natureActe = splitMatch[1].trim();
    const codeTokens = splitMatch[2].trim().split(/\s+/).filter(Boolean);
    if (codeTokens.length >= 2) {
      panierLabel = PANIER_MAP[codeTokens[codeTokens.length - 1]] || '';
      materiauLabel = codeTokens.slice(0, -1).map(c => MATERIAU_MAP[c]).filter(Boolean).join(', ');
    } else if (codeTokens.length === 1) {
      panierLabel = PANIER_MAP[codeTokens[0]] || '';
    }
  } else {
    natureActe = beforeAmounts;
  }

  // Premier montant = Honoraires (prix plein tarif)
  const montant = allAmounts.length > 0 ? allAmounts[0] : '0.00';

  return {
    code_ccam: codeCcam,
    nature_acte: natureActe,
    montant,
    numero_dent: dents.join(','),
    panier: panierLabel,
    materiau: materiauLabel
  };
}

/**
 * Extrait le premier montant depuis la ligne TOTAL du devis
 * "TOTAL € (des actes envisagés) 556,00 193,50 ..." → "556.00"
 * "TOTAL € (des actes envisagés) 1 236,00 204,25 ..." → "1236.00"
 */
function parseTotalMontant(line) {
  // Supprimer le préfixe "TOTAL ..."
  const afterTotal = line.replace(/^TOTAL[^)]+\)\s*/i, '').trim();
  // Premier montant: potentiellement avec séparateur millier "1 236,00"
  const m = afterTotal.match(/^(\d[\d\s]*,\d{2})/);
  if (!m) return null;
  return parseMontant(m[1]);
}

/**
 * Parse l'ensemble des lignes de texte extraites d'un devis
 * et retourne les données structurées pour Mon devis dentaire
 *
 * @param {string[]} textLines - Lignes de texte extraites du XPS/EMF
 * @returns {{ patient: Object, actes: Array } | null}
 */
function parseDevis(textLines) {
  let nom = null;
  let prenom = null;
  let dateNaissance = null;
  let nir = null;
  const rawActes = [];
  let stopActes = false; // stopper après la ligne TOTAL du devis principal
  const totalMontants = [];

  for (let i = 0; i < textLines.length; i++) {
    const line = textLines[i];
    const nextLine = textLines[i + 1] || '';

    // Patient
    if (!nom && /Nom et pr[eé]nom/i.test(line)) {
      const np = parseNomPrenom(line);
      if (np) { nom = np.nom; prenom = np.prenom; }
    }

    if (!dateNaissance && /Date de naissance/i.test(line)) {
      dateNaissance = parseDateNaissance(line);
    }

    // NIR peut être sur plusieurs lignes fusionnées avec d'autres infos
    if (!nir && /s[eé]curit[eé]\s*sociale/i.test(line)) {
      nir = parseNIR(line);
    }

    // Ligne TOTAL : source de vérité pour les montants globaux + fin de section principale
    if (!stopActes && /^TOTAL/i.test(line) && /actes/i.test(line)) {
      const total = parseTotalMontant(line);
      if (total) totalMontants.push(total);
      stopActes = true; // ignorer les CCAM des sections alternatives qui suivent
    }

    // Actes : uniquement dans la section principale (avant TOTAL)
    if (!stopActes && hasCCAM(line)) {
      const acte = parseActeLine(line, nextLine);
      if (acte) rawActes.push(acte);
    }
  }

  if (!nom || !nir) return null;

  // Regrouper par code CCAM : fusionner les dents, sommer les montants
  // (Logos imprime une ligne par dent, Mon devis dentaire attend un acte avec N dents)
  const acteMap = new Map();
  for (const acte of rawActes) {
    if (acteMap.has(acte.code_ccam)) {
      const existing = acteMap.get(acte.code_ccam);
      const existingDents = existing.numero_dent ? existing.numero_dent.split(',').filter(Boolean) : [];
      const newDents = acte.numero_dent ? acte.numero_dent.split(',').filter(Boolean) : [];
      const allDents = [...new Set([...existingDents, ...newDents])];
      existing.numero_dent = allDents.join(',');
      // Sommer les montants
      existing.montant = (parseFloat(existing.montant) + parseFloat(acte.montant)).toFixed(2);
    } else {
      acteMap.set(acte.code_ccam, { ...acte });
    }
  }
  const actes = Array.from(acteMap.values());

  // Si 1 seul acte et 1 TOTAL : le montant TOTAL est plus fiable (évite ambiguïtés)
  if (actes.length === 1 && totalMontants.length > 0) {
    actes[0].montant = totalMontants[0];
  }

  return {
    patient: { nom, prenom, dateNaissance, nir },
    actes
  };
}

/**
 * Construit l'URL Mon devis dentaire complète à partir des données parsées
 * @param {{ patient: Object, actes: Array }} data
 * @returns {string}
 */
function buildDevisUrl(data) {
  const base = 'https://app.mondevisdentaire.com/prises-en-charge/nouvelle';
  const { patient, actes } = data;

  const params = new URLSearchParams({
    source: 'cabflow-desktop',
    nom: patient.nom,
    prenom: patient.prenom,
    date_naissance: patient.dateNaissance,
    nir: patient.nir,
    actes: JSON.stringify(actes)
  });

  return `${base}?${params.toString()}`;
}

module.exports = { parseDevis, buildDevisUrl };
