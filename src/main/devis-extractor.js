/**
 * Devis Extractor - Parseur unifie pour devis dentaire a partir
 * de texte positionne (x, y, page) extrait via mupdf.
 *
 * Strategie:
 *  1. Reconstruire des lignes logiques en groupant les fragments par Y proche
 *  2. Extraire l'entete patient (nom/prenom/NIR/date naissance/adresse...)
 *  3. Extraire les metadonnees praticien (ADELI, RPPS, FINESS, cabinet)
 *  4. Extraire le tableau d'actes (CCAM, dents, libelle, montants, materiau, panier)
 *  5. Extraire les totaux (HT, TTC, part patient, part mutuelle, part AMO)
 *  6. Score de confiance (0-100)
 *
 * Compatibilite: garde la sortie identique a devis-parser.js (patient.nom/prenom/
 * dateNaissance/nir + actes[]) pour que buildDevisUrl marche tel quel.
 */

const PANIER_MAP = {
  '1': 'RAC0',
  '2': 'modere',
  '3': 'libre',
  '4': 'CSS'
};

const MATERIAU_MAP = {
  '1': 'Alliage precieux',
  '2': 'Alliage non precieux',
  '3': 'Ceramo-ceramique',
  '4': 'Ceramique ceramometallique',
  '5': 'Polymeres de base',
  '6': 'Dents artificielles'
};

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[DEVIS-EXT] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

/**
 * Convertit "1 236,00" -> "1236.00"
 */
function parseMontant(str) {
  if (!str) return '0.00';
  return String(str).replace(/\s/g, '').replace(',', '.');
}

/**
 * Groupe les lignes positionnees par Y proche (meme ligne visuelle)
 * @param {Array<{page,x,y,text}>} positioned - sortie de ps-to-pdf.flattenToLines
 * @param {number} yTolerance - tolerance verticale en points PDF (defaut 4)
 * @returns {Array<{page, y, fragments: Array, text: string}>}
 */
function groupByVisualLine(positioned, yTolerance = 4) {
  // Tri par (page, y, x)
  const sorted = [...positioned].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(a.y - b.y) > yTolerance) return a.y - b.y;
    return a.x - b.x;
  });

  const lines = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (last && last.page === item.page && Math.abs(last.y - item.y) <= yTolerance) {
      last.fragments.push(item);
      last.y = (last.y * (last.fragments.length - 1) + item.y) / last.fragments.length;
    } else {
      lines.push({
        page: item.page,
        y: item.y,
        fragments: [item]
      });
    }
  }

  // Generer le texte concat avec espace
  for (const line of lines) {
    line.fragments.sort((a, b) => a.x - b.x);
    line.text = line.fragments.map(f => f.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  return lines;
}

// ============================================
// EXTRACTEURS DE CHAMPS
// ============================================

function extractPatient(lines) {
  const patient = {
    nom: null, prenom: null, dateNaissance: null, nir: null,
    adresse: null, ville: null, cp: null, telephone: null
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;

    if (!patient.nom) {
      // "Nom et prenom" suivi d'un nom en MAJUSCULES (peut etre compose: DA ROCHA, DE LA TORRE)
      // puis d'un prenom Capitalise (peut avoir deuxieme prenom)
      // Strategie en 2 temps: capturer tout apres ":", separer nom (maj) / prenom (Maj+min)
      const m = line.match(/Nom\s+et\s+pr[a-zÀ-ſ]{1,3}nom\s*[:\-]?\s*(.+?)(?:\s+Page\s+\d|\s+Devis|\s{3,}|$)/i);
      if (m) {
        const raw = m[1].trim();
        // Separer: tokens en MAJUSCULES (incluant accents) = nom, puis tokens Capitalises = prenom
        const tokens = raw.split(/\s+/);
        const nomTokens = [];
        const prenomTokens = [];
        for (const t of tokens) {
          const isUpper = /^[A-ZÀ-Ü][A-ZÀ-Ü\-']*$/.test(t);
          if (isUpper && prenomTokens.length === 0) nomTokens.push(t);
          else prenomTokens.push(t);
        }
        if (nomTokens.length > 0 && prenomTokens.length > 0) {
          patient.nom = nomTokens.join(' ');
          patient.prenom = prenomTokens.join(' ');
        } else if (nomTokens.length > 0) {
          patient.nom = nomTokens.join(' ');
        }
      }
    }

    if (!patient.dateNaissance) {
      // Accents possibles "Date de naissance", "Date naissance"
      const m = line.match(/Date\s+de?\s*naissance\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4})/i);
      if (m) patient.dateNaissance = m[1].replace(/[\-\.]/g, '/');
    }

    if (!patient.nir) {
      // Accent insensible: "N de securite sociale", "Numero securite sociale", "NIR"
      // Tolerance large pour les accents/decodage imparfait
      const m = line.match(/(?:N[°o ]+|Num[eé]?ro\s+)(?:de\s+)?s[a-z]?[eé]?curit[a-z]?[eé]?\s*sociale[^:0-9]*[:\-]?\s*([\d\s]{13,25})/i);
      if (m) {
        const cleaned = m[1].replace(/\s/g, '');
        if (cleaned.length >= 13) patient.nir = cleaned;
      } else {
        // Fallback: NIR isole quelque part sur la ligne
        const m2 = line.match(/\b([12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}(?:\s?\d{2})?)\b/);
        if (m2) {
          const cleaned = m2[1].replace(/\s/g, '');
          if (cleaned.length >= 13) patient.nir = cleaned;
        }
      }
    }

    if (!patient.cp || !patient.ville) {
      const m = line.match(/\b(\d{5})\s+([A-ZÀ-Ü][A-ZÀ-Üa-zà-ü\s\-']{2,})\b/);
      if (m && /(?:Adresse|patient|domicile)/i.test([lines[i - 1]?.text, lines[i - 2]?.text, line].join(' '))) {
        patient.cp = m[1];
        patient.ville = m[2].trim();
      }
    }

    if (!patient.telephone) {
      const m = line.match(/(?:t[eé]l[eé]phone|tel|portable|mobile)\s*[:\-]?\s*((?:\+33|0)[\s\.\-]?\d(?:[\s\.\-]?\d{2}){4})/i);
      if (m) patient.telephone = m[1].replace(/[\s\.\-]/g, '');
    }
  }

  return patient;
}

function extractPraticien(lines) {
  const praticien = { nom: null, adeli: null, rpps: null, specialite: null };

  for (const { text } of lines) {
    if (!praticien.adeli) {
      const m = text.match(/ADELI\s*[:\-]?\s*(\d{8,11})/i);
      if (m) praticien.adeli = m[1];
    }
    if (!praticien.rpps) {
      const m = text.match(/RPPS\s*[:\-]?\s*(\d{10,11})/i);
      if (m) praticien.rpps = m[1];
    }
    if (!praticien.nom) {
      // "Docteur Yoram MAMAN" - stoppe au prochain mot de libelle (Nom, Identifiant, etc.)
      const m = text.match(/(?:Dr|Docteur|Chirurgien[\-\s]dentiste)\.?\s+([A-ZÀ-Ü][A-ZÀ-Üa-zà-ü\-']+(?:\s+[A-ZÀ-Ü][A-ZÀ-Üa-zà-ü\-']+){0,3}?)(?=\s+(?:Nom|Identifiant|Raison|N|Date|FINESS|RPPS|ADELI)\b|$)/);
      if (m) praticien.nom = m[1].trim();
    }
    if (!praticien.specialite) {
      const m = text.match(/Sp[eé]cialit[eé]\s*[:\-]?\s*([A-ZÀ-Üa-zà-ü\s\-]+)/i);
      if (m) praticien.specialite = m[1].trim();
    }
  }

  return praticien;
}

function extractCabinet(lines) {
  const cabinet = { nom: null, adresse: null, ville: null, cp: null, telephone: null, finess: null };

  for (const { text } of lines) {
    if (!cabinet.finess) {
      const m = text.match(/FINESS\s*[:\-]?\s*(\d{9})/i);
      if (m) cabinet.finess = m[1];
    }
    if (!cabinet.telephone) {
      const m = text.match(/(?:T[eé]l|Telephone)\s*[:\-]?\s*((?:\+33|0)[\s\.\-]?\d(?:[\s\.\-]?\d{2}){4})/i);
      if (m) cabinet.telephone = m[1].replace(/[\s\.\-]/g, '');
    }
  }

  return cabinet;
}

function extractDates(lines) {
  const dates = { devis: null, validite: null };
  for (const { text } of lines) {
    if (!dates.devis) {
      const m = text.match(/Date\s+(?:du\s+)?devis\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) dates.devis = m[1];
    }
    if (!dates.validite) {
      const m = text.match(/(?:Validit[eé]|Valable jusqu)[^0-9]*(\d{1,2}\/\d{1,2}\/\d{4})/i);
      if (m) dates.validite = m[1];
    }
  }
  return dates;
}

function extractTotaux(lines) {
  const totaux = {
    totalHT: null, totalTTC: null, partPatient: null, partMutuelle: null, partAMO: null
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    const amount = (s) => {
      const m = String(s).match(/(\d{1,3}(?:\s\d{3})*[,.]\d{2})/);
      return m ? parseMontant(m[1]) : null;
    };

    if (!totaux.totalTTC) {
      if (/Total\s+TTC|Montant\s+total\s+TTC/i.test(text)) totaux.totalTTC = amount(text);
    }
    if (!totaux.totalHT) {
      if (/Total\s+HT|Montant\s+total\s+HT/i.test(text)) totaux.totalHT = amount(text);
    }
    if (!totaux.partMutuelle) {
      if (/(?:Mutuelle|Compl[eé]mentaire)/i.test(text) && /\d+[,.]\d{2}/.test(text)) {
        totaux.partMutuelle = amount(text);
      }
    }
    if (!totaux.partAMO) {
      if (/(?:Assurance\s+maladie|S[eé]curit[eé]\s+sociale|AMO|R[eé]gime\s+obligatoire)/i.test(text) && /\d+[,.]\d{2}/.test(text)) {
        totaux.partAMO = amount(text);
      }
    }
    if (!totaux.partPatient) {
      if (/(?:Reste\s+a\s+charge|Part\s+patient|RAC)/i.test(text)) totaux.partPatient = amount(text);
    }
  }
  return totaux;
}

/**
 * Extrait le numero de devis depuis l'entete
 */
function extractDevisNumero(lines) {
  for (const { text } of lines) {
    const m = text.match(/(?:N[°o]\s*(?:de\s+)?devis|Devis\s+n[°o])\s*[:\-]?\s*(\w+)/i);
    if (m) return m[1];
  }
  return null;
}

// ============================================
// EXTRACTION DES ACTES
// ============================================

function hasCCAM(text) {
  return /\b[A-Z]{4}\d{3}\b/.test(text);
}

function parseActeLine(line, nextLine) {
  const text = line.text;
  const ccamMatch = text.match(/\b([A-Z]{4}\d{3})\b/);
  if (!ccamMatch) return null;
  const codeCcam = ccamMatch[1];

  const beforeCcam = text.substring(0, text.indexOf(codeCcam));
  const dentNumbers = beforeCcam.match(/\b(\d{1,2})\b/g) || [];
  const dents = dentNumbers.slice(1).filter(d => {
    const n = parseInt(d, 10);
    return n >= 11 && n <= 85;
  });

  // Continuation: ligne suivante avec uniquement des numeros de dents
  if (nextLine && /^\d{1,2}(\s+\d{1,2})*$/.test(nextLine.text.trim())) {
    const extra = nextLine.text.trim().split(/\s+/).filter(d => {
      const n = parseInt(d, 10);
      return n >= 11 && n <= 85;
    });
    dents.push(...extra);
  }

  const afterCcam = text.substring(text.indexOf(codeCcam) + codeCcam.length);
  const cleaned = afterCcam.replace(/\s+\b(Aucun|oui|non)\b/gi, '').trim();

  // Regle ferme pour les lignes d'actes dentaires Logos:
  //   - Les codes mat/panier sont des chiffres entiers ISOLES (1-9) precedant les montants
  //   - Les montants sont au format "DDD,DD" (jamais > 999,99€ par acte unique)
  //   - Si on voit "X DDD,DD" (avec X un entier 1-9 separe par espace), c'est TOUJOURS
  //     "code X" + "montant DDD,DD", JAMAIS un format millier "XDDDDDD,DD"
  //
  // Le format millier "X DDD,DD" n'apparait QUE dans la ligne TOTAL du devis,
  // pas dans les lignes d'actes individuels (1 acte depasse rarement 1000€).
  const amountRe = /(?<![,\d])(\d{1,3},\d{2})\b/g;
  const allAmounts = [];
  let m;
  while ((m = amountRe.exec(cleaned)) !== null) {
    allAmounts.push(parseMontant(m[1]));
  }

  const firstAmtPos = cleaned.search(/(?<![,\d])\d{1,3},\d{2}\b/);
  const beforeAmounts = (firstAmtPos >= 0 ? cleaned.substring(0, firstAmtPos) : cleaned).trim();

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

  return {
    code_ccam: codeCcam,
    nature_acte: natureActe,
    montant: allAmounts.length > 0 ? allAmounts[0] : '0.00',
    numero_dent: dents.join(','),
    panier: panierLabel,
    materiau: materiauLabel,
    _all_amounts: allAmounts // debug
  };
}

function extractActes(lines) {
  const rawActes = [];
  let stopActes = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextLine = lines[i + 1];

    if (!stopActes && /^TOTAL/i.test(line.text) && /actes/i.test(line.text)) {
      stopActes = true;
      continue;
    }

    if (!stopActes && hasCCAM(line.text)) {
      const acte = parseActeLine(line, nextLine);
      if (acte) rawActes.push(acte);
    }
  }

  // Regrouper par CCAM, fusionner les dents, sommer les montants
  const acteMap = new Map();
  for (const acte of rawActes) {
    if (acteMap.has(acte.code_ccam)) {
      const existing = acteMap.get(acte.code_ccam);
      const existingDents = existing.numero_dent ? existing.numero_dent.split(',').filter(Boolean) : [];
      const newDents = acte.numero_dent ? acte.numero_dent.split(',').filter(Boolean) : [];
      existing.numero_dent = [...new Set([...existingDents, ...newDents])].join(',');
      existing.montant = (parseFloat(existing.montant) + parseFloat(acte.montant)).toFixed(2);
    } else {
      acteMap.set(acte.code_ccam, { ...acte });
    }
  }
  return Array.from(acteMap.values()).map(a => {
    delete a._all_amounts;
    return a;
  });
}

// ============================================
// SCORING DE CONFIANCE
// ============================================

function scoreConfidence(result) {
  let score = 0;
  if (result.patient.nom) score += 15;
  if (result.patient.prenom) score += 10;
  if (result.patient.dateNaissance) score += 15;
  if (result.patient.nir) score += 20;
  if (result.actes && result.actes.length > 0) score += 25;
  if (result.actes && result.actes.length > 0 &&
      result.actes.every(a => parseFloat(a.montant) > 0)) score += 10;
  if (result.praticien.adeli || result.praticien.rpps) score += 5;
  return Math.min(score, 100);
}

// ============================================
// API PUBLIQUE
// ============================================

/**
 * Trouve la position X d'une colonne en cherchant un mot-cle dans l'en-tete du tableau.
 * Retourne le X du segment qui matche le pattern.
 */
function findColumnX(rows, synonymsRegex) {
  for (const row of rows) {
    row.items.sort((a,b) => a.x0-b.x0);
    const segments = [];
    let cur = null;
    let lastX = null;
    for (const it of row.items) {
      if (!cur || (lastX !== null && it.x0 - lastX > 7)) {
        cur = { x: it.x0, text: '' };
        segments.push(cur);
      }
      cur.text += it.c;
      lastX = it.x1;
    }
    for (const s of segments) s.text = s.text.replace(/\s+/g, ' ').trim();
    for (const s of segments) {
      if (synonymsRegex.test(s.text)) return s.x;
    }
  }
  return null;
}

/**
 * Trouve la position X de la colonne "Honoraires"
 */
function findHonorairesColumnX(rows) {
  return findColumnX(rows, /^(Honoraires?|Montant|Prix\s+de\s+vente|Total)/i);
}

/**
 * Trouve la position X de la colonne "N° dent" / "Localisation".
 * Patterns specifiques au CERFA: "N° dent ou", "N° dent ou localisation",
 * "Localisation", "Secteur". Eviter "N°" tout court qui matche aussi
 * "N° de securite sociale" / "N° de contrat" etc.
 */
function findDentColumnX(rows) {
  return findColumnX(rows, /^(N[°o]\s*dent|Localisation|Secteur|Dent\s*ou|Dents?\s*$)/i);
}

/**
 * Verifie si un token est un numero de dent valide (11-85) OU un secteur
 * (00, 01-10, 20, 30, 40).
 */
function isDentOrSector(token) {
  if (!/^\d{1,2}$/.test(token)) return false;
  const n = parseInt(token, 10);
  // Dents standards (11-85)
  if (n >= 11 && n <= 18) return true;
  if (n >= 21 && n <= 28) return true;
  if (n >= 31 && n <= 38) return true;
  if (n >= 41 && n <= 48) return true;
  if (n >= 51 && n <= 55) return true;
  if (n >= 61 && n <= 65) return true;
  if (n >= 71 && n <= 75) return true;
  if (n >= 81 && n <= 85) return true;
  // Secteurs / mâchoires: 00, 01-10, 20, 30, 40
  if (n >= 0 && n <= 10) return true;
  if (n === 20 || n === 30 || n === 40) return true;
  return false;
}

/**
 * Extrait les actes en utilisant les positions X des colonnes (mode haute fiabilite).
 *
 * STRATEGIE UNIVERSELLE:
 *  1. Trouver la position X de la colonne "Honoraires" via l'entete du tableau
 *  2. Pour chaque ligne contenant un code CCAM, prendre le montant dont le X est
 *     le plus proche de la colonne Honoraires (tolerance +/- 15pt)
 *  3. Le N° dent est dans le segment avant CCAM, la nature dans le segment apres
 *
 * Cette methode est universelle: peu importe la position exacte des colonnes
 * (qui peut varier selon le logiciel ou la mise en page), on identifie toujours
 * la bonne colonne via son entete.
 *
 * @param {Array} chars - sortie de psToPdf.parseTxtwriteXml ({x0,y0,x1,y1,page,c})
 * @returns {Array} actes
 */
function extractActesByColumns(chars) {
  if (!chars || chars.length === 0) return [];

  // 1. Regrouper les chars par ligne (page + y proche)
  const sorted = [...chars].sort((a,b) => a.page-b.page || a.y0-b.y0 || a.x0-b.x0);
  const rows = [];
  let cur = null;
  for (const c of sorted) {
    if (!cur || cur.page !== c.page || Math.abs(cur.y - c.y0) > 2) {
      cur = { page: c.page, y: c.y0, items: [c] };
      rows.push(cur);
    } else cur.items.push(c);
  }

  // 2. Trouver les positions X des colonnes via l'entete du tableau
  const honorairesX = findHonorairesColumnX(rows);
  const dentX = findDentColumnX(rows);
  log(`Colonne Honoraires detectee a x=${honorairesX !== null ? honorairesX.toFixed(0) : '?'}`);
  log(`Colonne Dent/Loc detectee a x=${dentX !== null ? dentX.toFixed(0) : '?'}`);

  // Helper: segmenter une ligne en colonnes par gap X > 7pt
  function segmentRow(row) {
    row.items.sort((a,b) => a.x0-b.x0);
    const segments = [];
    let seg = null;
    let lastX = null;
    for (const it of row.items) {
      if (!seg || (lastX !== null && it.x0 - lastX > 7)) {
        seg = { x: it.x0, text: '' };
        segments.push(seg);
      }
      seg.text += it.c;
      lastX = it.x1;
    }
    for (const s of segments) s.text = s.text.replace(/\s+/g, ' ').trim();
    return segments;
  }

  // Helper: fullText avec espaces aux gaps
  function fullTextOf(row) {
    row.items.sort((a,b) => a.x0-b.x0);
    let t = '';
    let lastX = null;
    for (const it of row.items) {
      if (lastX !== null && it.x0 - lastX > 1.5) t += ' ';
      t += it.c;
      lastX = it.x1;
    }
    return t.replace(/\s+/g, ' ').trim();
  }

  // 3. Identifier les lignes d'actes (contiennent un code CCAM) jusqu'a la ligne TOTAL.
  // Capturer aussi les LIGNES DE CONTINUATION qui suivent un acte:
  // ligne sans CCAM, avec uniquement des numeros de dents/secteurs, et
  // au moins un segment dans la zone dentX (+/- 50pt).
  const acteRows = [];
  let stopActes = false;
  let lastActeRow = null; // pour rattacher les continuations
  for (const row of rows) {
    const fullText = fullTextOf(row);
    if (!stopActes && /^TOTAL/i.test(fullText) && /actes/i.test(fullText)) {
      stopActes = true;
      continue;
    }
    if (stopActes) continue;

    const segments = segmentRow(row);

    if (/[A-Z]{4}\d{3}/.test(fullText)) {
      if (fullText.length > 300) continue;
      const acteRow = { y: row.y, fullText, segments, continuationDents: [] };
      acteRows.push(acteRow);
      lastActeRow = acteRow;
    } else if (lastActeRow && fullText.length < 100) {
      // Possible continuation: chercher dans les segments des numeros de dents valides
      // dans la zone proche de dentX (si connue)
      let cdents = [];
      for (const s of segments) {
        const inDentColumn = dentX === null || Math.abs(s.x - dentX) < 60;
        if (!inDentColumn) continue;
        const tokens = s.text.split(/\s+/).filter(Boolean);
        for (const t of tokens) {
          if (isDentOrSector(t)) cdents.push(t);
        }
      }
      // Sanity: la ligne doit etre presque exclusivement des chiffres dents
      // (sinon c'est du texte de pied de page ou autre)
      const onlyDentTokens = fullText.split(/\s+/).filter(Boolean).every(t => isDentOrSector(t));
      if (onlyDentTokens && cdents.length > 0) {
        lastActeRow.continuationDents.push(...cdents);
      } else {
        lastActeRow = null; // fin de la continuation
      }
    } else {
      lastActeRow = null;
    }
  }
  log(`Lignes d'actes detectees: ${acteRows.length}`);

  // 4. Pour chaque ligne d'acte, extraire CCAM, dent, nature, et MONTANT par X de colonne
  const acteMap = new Map();
  for (const acteRow of acteRows) {
    const { segments, continuationDents } = acteRow;
    // CCAM = segment qui matche [A-Z]{4}\d{3}
    const ccamSeg = segments.find(s => /^[A-Z]{4}\d{3}$/.test(s.text));
    if (!ccamSeg) continue;
    const codeCcam = ccamSeg.text;
    const ccamIdx = segments.indexOf(ccamSeg);

    // Nature = segment suivant le CCAM
    const natureSeg = segments[ccamIdx + 1];
    const natureActe = natureSeg ? natureSeg.text : '';

    // N° dent / localisation:
    //   - "Haut/Sup/Max" -> "01"  (maxillaire)
    //   - "Bas/Inf/Mand" -> "02"  (mandibule)
    //   - Sinon: capture TOUS les tokens de la colonne dent qui sont des numeros valides
    //     (dents 11-85 OU secteurs 00-10, 20, 30, 40)
    //   - Inclut aussi les dents des lignes de CONTINUATION (acte sur >1 ligne)
    let dents = '';
    const dentSeg = segments[ccamIdx - 1];
    if (dentSeg) {
      const t = dentSeg.text.trim();
      if (/^(Haut|Sup|Max)/i.test(t)) {
        dents = '01';
      } else if (/^(Bas|Inf|Mand)/i.test(t)) {
        dents = '02';
      } else {
        // Collecte tous les tokens dents/secteurs (de la ligne principale + continuations)
        const collected = [];
        // Strategie principale: segments situes a gauche du CCAM
        for (let i = 0; i < ccamIdx; i++) {
          const seg = segments[i];
          const tokens = seg.text.split(/\s+/).filter(Boolean);
          for (const tok of tokens) {
            if (isDentOrSector(tok)) {
              // Filtrer le N° de traitement (1er chiffre, x ~56)
              // = segment 0 avec un seul token <= 10 et x < 70
              if (i === 0 && seg.x < 70 && tokens.length === 1 && parseInt(tok, 10) <= 10) {
                continue;
              }
              collected.push(tok);
            }
          }
        }
        // Ajouter les dents des lignes de continuation
        if (continuationDents && continuationDents.length > 0) {
          collected.push(...continuationDents);
        }
        if (collected.length > 0) {
          // Dedup tout en preservant l'ordre
          const seen = new Set();
          const unique = collected.filter(d => seen.has(d) ? false : (seen.add(d), true));
          dents = unique.join(',');
        }
      }
    }

    // MONTANT - double mecanisme de securite:
    //   (1) Position X: proche de la colonne "Honoraires" detectee dans l'entete
    //   (2) Valeur: la colonne Honoraires contient TOUJOURS le plus grand montant
    //       de la ligne (les autres colonnes = bases, remboursements, restes < honoraires)
    //
    // En cas de desaccord entre (1) et (2), on prend (2) qui est le critere le plus fiable.
    const amountSegs = segments.filter(s => /^(\d{1,3}(?:\s\d{3})*,\d{2})$/.test(s.text));
    let honoraires = null;

    if (amountSegs.length > 0) {
      // Critere (2): trouver le montant max (parmi tous, valeur numerique)
      let maxSeg = amountSegs[0];
      let maxVal = parseFloat(parseMontant(maxSeg.text));
      for (const s of amountSegs) {
        const v = parseFloat(parseMontant(s.text));
        if (v > maxVal) { maxVal = v; maxSeg = s; }
      }

      // Critere (1): segment le plus proche de la colonne Honoraires
      let nearSeg = null;
      if (honorairesX !== null) {
        let bestDist = Infinity;
        for (const s of amountSegs) {
          const dist = Math.abs(s.x - honorairesX);
          if (dist < bestDist && dist <= 30) {
            bestDist = dist;
            nearSeg = s;
          }
        }
      }

      // Decision finale: combiner les 2 criteres
      if (nearSeg && maxSeg) {
        // Si meme segment: parfait
        if (nearSeg === maxSeg) {
          honoraires = parseMontant(maxSeg.text);
        } else {
          // Desaccord: privilegier MAX (critere plus fiable)
          // Sauf si nearSeg vaut EXACTEMENT autant que maxSeg (cas "honoraires = base")
          const nearVal = parseFloat(parseMontant(nearSeg.text));
          if (nearVal === maxVal) {
            honoraires = parseMontant(nearSeg.text);
          } else {
            honoraires = parseMontant(maxSeg.text);
          }
        }
      } else if (nearSeg) {
        honoraires = parseMontant(nearSeg.text);
      } else if (maxSeg) {
        honoraires = parseMontant(maxSeg.text);
      }
    }

    const acte = {
      code_ccam: codeCcam,
      nature_acte: natureActe,
      montant: honoraires != null ? honoraires : '0.00',
      numero_dent: dents,
      panier: '',
      materiau: ''
    };

    // Regrouper par CCAM: fusionner dents + sommer montants
    if (acteMap.has(codeCcam)) {
      const existing = acteMap.get(codeCcam);
      const existingDents = existing.numero_dent ? existing.numero_dent.split(',').filter(Boolean) : [];
      const newDents = acte.numero_dent ? acte.numero_dent.split(',').filter(Boolean) : [];
      existing.numero_dent = [...new Set([...existingDents, ...newDents])].join(',');
      existing.montant = (parseFloat(existing.montant) + parseFloat(acte.montant)).toFixed(2);
    } else {
      acteMap.set(codeCcam, acte);
    }
  }

  return Array.from(acteMap.values());
}

/**
 * Extrait toutes les donnees d'un devis a partir du texte positionne
 * @param {Array<{page,x,y,text}>} positionedLines - sortie ps-to-pdf.flattenToLines
 * @param {Array} chars - optionnel: chars positionnes pour extraction actes par colonnes
 * @returns {{patient, praticien, cabinet, devis, actes, confidence, rawLines}}
 */
function extractFromPositionedText(positionedLines, chars) {
  const lines = groupByVisualLine(positionedLines);
  log(`${lines.length} lignes visuelles reconstruites depuis ${positionedLines.length} fragments`);

  const patient = extractPatient(lines);
  const praticien = extractPraticien(lines);
  const cabinet = extractCabinet(lines);
  const dates = extractDates(lines);
  const totaux = extractTotaux(lines);
  const numero = extractDevisNumero(lines);

  // Extraction actes: PREFERER extractActesByColumns (positions X fiables)
  // si on a les chars positionnes; sinon fallback sur extractActes (regex texte)
  let actes;
  if (chars && chars.length > 0) {
    actes = extractActesByColumns(chars);
    log(`Actes par colonnes: ${actes.length} extraits`);
    if (actes.length === 0) {
      // Fallback regex si l'extraction par colonnes echoue (positions atypiques)
      actes = extractActes(lines);
      log(`Fallback regex texte: ${actes.length} actes`);
    }
  } else {
    actes = extractActes(lines);
  }

  const result = {
    patient,
    praticien,
    cabinet,
    devis: { numero, ...dates, ...totaux },
    actes,
    rawLines: lines.map(l => l.text)
  };
  result.confidence = scoreConfidence(result);

  log(`Patient: ${patient.nom || '?'} ${patient.prenom || ''} | NIR: ${patient.nir ? 'OK' : 'ABSENT'} | ${actes.length} actes | confiance=${result.confidence}`);

  return result;
}

/**
 * Construit l'URL Mon devis dentaire compatible avec buildDevisUrl existant
 */
function buildDevisUrl(data) {
  const base = 'https://app.mondevisdentaire.com/prises-en-charge/nouvelle';
  const params = new URLSearchParams({
    source: 'cabflow-desktop-pdf',
    nom: data.patient.nom || '',
    prenom: data.patient.prenom || '',
    date_naissance: data.patient.dateNaissance || '',
    nir: data.patient.nir || '',
    actes: JSON.stringify(data.actes || [])
  });
  return `${base}?${params.toString()}`;
}

module.exports = {
  setLogger,
  extractFromPositionedText,
  buildDevisUrl,
  // exports pour tests
  groupByVisualLine,
  extractPatient,
  extractActes,
  extractActesByColumns,
  scoreConfidence
};
