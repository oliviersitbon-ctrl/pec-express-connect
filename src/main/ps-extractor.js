/**
 * PostScript Text Extractor
 *
 * Extrait le texte et les données patient/actes depuis un fichier PostScript
 * généré par CUPS lors de l'impression.
 *
 * Le PostScript contient le texte entre parenthèses: (texte) show
 * On extrait ces fragments et on les analyse.
 */

const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const { getConfig } = require('./config-manager');

/**
 * Logger
 */
function log(message) {
  console.log(`[PSExtractor] ${message}`);
}

/**
 * Extrait tous les fragments de texte d'un fichier PostScript
 */
function extractTextFragments(psContent) {
  const fragments = [];

  // Pattern PostScript pour le texte: (texte) show ou (texte) Tj
  // Le texte peut contenir des échappements: \( \) \\ \nnn (octal)
  const textPatterns = [
    /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*(?:show|Tj|TJ)/g,
    /\(([^()\\]*(?:\\.[^()\\]*)*)\)\s*S\b/g,
    /<([0-9A-Fa-f]+)>\s*Tj/g, // Hex strings
  ];

  for (const pattern of textPatterns) {
    let match;
    while ((match = pattern.exec(psContent)) !== null) {
      let text = match[1];

      // Décoder les échappements PostScript
      text = text
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\')
        .replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));

      if (text.trim()) {
        fragments.push(text.trim());
      }
    }
  }

  return fragments;
}

/**
 * Reconstruit le texte complet depuis les fragments
 */
function reconstructText(fragments) {
  // Joindre les fragments, en détectant les lignes
  let text = '';
  let lastFragment = '';

  for (const frag of fragments) {
    // Si le fragment commence par une majuscule après un mot, nouvelle ligne probable
    if (lastFragment && /[a-z]$/.test(lastFragment) && /^[A-Z]/.test(frag)) {
      text += '\n';
    } else if (lastFragment) {
      text += ' ';
    }
    text += frag;
    lastFragment = frag;
  }

  return text;
}

/**
 * Extrait les informations patient du texte
 */
function extractPatientInfo(text, config) {
  const data = {
    nom: null,
    prenom: null,
    date_naissance: null,
    nir: null
  };

  // Pattern pour date de naissance
  const datePattern = new RegExp(config.patterns?.date || '\\d{1,2}[/\\-\\.]\\d{1,2}[/\\-\\.]\\d{4}', 'g');
  const dates = text.match(datePattern) || [];

  // Chercher une date de naissance valide (personne > 1 an)
  for (const dateStr of dates) {
    const normalized = dateStr.replace(/\s+/g, '').replace(/[\-\.]/g, '/');
    const parts = normalized.split('/');
    if (parts.length === 3) {
      const year = parseInt(parts[2], 10);
      const currentYear = new Date().getFullYear();
      if (year >= 1920 && year <= currentYear - 1) {
        data.date_naissance = normalized;
        log(`Date naissance trouvée: ${data.date_naissance}`);
        break;
      }
    }
  }

  // Pattern pour NIR (numéro de sécu)
  const nirPattern = /[12]\s*\d{2}\s*\d{2}\s*\d{2}\s*\d{3}\s*\d{3}\s*\d{2}/g;
  const nirMatch = text.match(nirPattern);
  if (nirMatch) {
    data.nir = nirMatch[0].replace(/\s+/g, '');
    log(`NIR trouvé: ${data.nir}`);
  }

  // Pattern pour nom (MAJUSCULES) suivi de prénom (Capitalisé)
  const namePattern = /([A-ZÉÈÊËÀÂÄÙÛÜÔÖÎÏ]{2,})\s+([A-ZÉÈÊËÀÂÄÙÛÜÔÖÎÏ][a-zéèêëàâäùûüôöîï]+)/g;
  let nameMatch;
  while ((nameMatch = namePattern.exec(text)) !== null) {
    const potentialNom = nameMatch[1];
    const potentialPrenom = nameMatch[2];

    // Filtrer les mots parasites
    const parasites = config.parasites || [];
    if (!parasites.includes(potentialNom.toUpperCase())) {
      data.nom = potentialNom;
      data.prenom = potentialPrenom;
      log(`Nom/Prénom trouvés: ${data.nom} ${data.prenom}`);
      break;
    }
  }

  return data;
}

/**
 * Extrait les actes dentaires du texte
 */
function extractActes(text, config) {
  const actes = [];
  const ccamPattern = new RegExp(config.patterns?.ccam || '[A-Z]{4}\\d{3}', 'g');
  const dentPattern = new RegExp(config.patterns?.dent || '(?:1[1-8]|2[1-8]|3[1-8]|4[1-8])', 'g');

  // Trouver tous les codes CCAM
  const ccamMatches = text.match(ccamPattern) || [];
  const uniqueCcam = [...new Set(ccamMatches)];

  for (const ccam of uniqueCcam) {
    const acte = {
      code_ccam: ccam
    };

    // Chercher un montant près du code CCAM
    const ccamIndex = text.indexOf(ccam);
    const context = text.substring(Math.max(0, ccamIndex - 100), ccamIndex + 200);

    // Pattern pour montants: 123,45 ou 1 234,56
    const montantPattern = /(\d{1,3}(?:\s\d{3})*)[,.](\d{2})/g;
    const montants = [];
    let montantMatch;
    while ((montantMatch = montantPattern.exec(context)) !== null) {
      const montant = parseFloat(montantMatch[1].replace(/\s/g, '') + '.' + montantMatch[2]);
      if (montant >= 5 && montant <= 50000) {
        montants.push(montant);
      }
    }

    // Prendre le montant le plus élevé comme prix
    if (montants.length > 0) {
      acte.prix = Math.max(...montants);
    }

    // Chercher un numéro de dent
    const dentMatches = context.match(dentPattern);
    if (dentMatches && dentMatches.length > 0) {
      acte.numero_dent = dentMatches[0];
    }

    actes.push(acte);
  }

  log(`${actes.length} actes extraits`);
  return actes;
}

/**
 * Extrait le texte en utilisant Ghostscript (meilleure extraction)
 */
function extractTextWithGhostscript(filePath) {
  try {
    // Créer un fichier temporaire pour la sortie
    const tmpFile = path.join(os.tmpdir(), `cabflow_${Date.now()}.txt`);

    // Ghostscript txtwrite device extrait le texte rendu
    execSync(
      `gs -sDEVICE=txtwrite -sOutputFile="${tmpFile}" -dNOPAUSE -dBATCH -dQUIET "${filePath}" 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 60000 }
    );

    if (fs.existsSync(tmpFile)) {
      const result = fs.readFileSync(tmpFile, 'utf8');
      fs.unlinkSync(tmpFile); // Nettoyer
      return result;
    }
    return null;
  } catch (e) {
    log(`Ghostscript échoué: ${e.message}`);
    return null;
  }
}

/**
 * Extrait le texte en utilisant cupsfilter (conversion PS → texte)
 */
function extractTextWithCupsfilter(filePath) {
  try {
    // Essayer de convertir PS en texte brut avec cupsfilter
    const result = execSync(
      `cupsfilter -m text/plain "${filePath}" 2>/dev/null`,
      { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 30000 }
    );
    return result;
  } catch (e) {
    log(`cupsfilter échoué: ${e.message}`);
    return null;
  }
}

/**
 * Extrait le texte en utilisant la commande strings
 */
function extractTextWithStrings(filePath) {
  try {
    const result = execSync(
      `strings -n 3 "${filePath}" | grep -vE "^[%/\\\\]" | head -1000`,
      { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
    );
    return result;
  } catch (e) {
    log(`strings échoué: ${e.message}`);
    return null;
  }
}

/**
 * Extrait toutes les données d'un fichier PostScript
 * Essaie plusieurs méthodes d'extraction dans l'ordre
 */
function extractFromPS(filePath) {
  log(`Extraction depuis: ${filePath}`);

  const config = getConfig();
  let fullText = '';

  // Méthode 1: Extraction directe des fragments PS
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fragments = extractTextFragments(content);
    log(`Méthode 1 (fragments PS): ${fragments.length} fragments`);

    if (fragments.length > 10) {
      fullText = reconstructText(fragments);
    }
  } catch (e) {
    log(`Méthode 1 échouée: ${e.message}`);
  }

  // Méthode 2: Ghostscript txtwrite (meilleure extraction pour PDF→PS)
  if (fullText.length < 100) {
    log('Tentative méthode 2: Ghostscript...');
    const gsText = extractTextWithGhostscript(filePath);
    if (gsText && gsText.length > fullText.length) {
      fullText = gsText;
      log(`Méthode 2 (Ghostscript): ${fullText.length} caractères`);
    }
  }

  // Méthode 3: cupsfilter (si Ghostscript n'est pas installé)
  if (fullText.length < 100) {
    log('Tentative méthode 3: cupsfilter...');
    const cupsText = extractTextWithCupsfilter(filePath);
    if (cupsText && cupsText.length > fullText.length) {
      fullText = cupsText;
      log(`Méthode 3 (cupsfilter): ${fullText.length} caractères`);
    }
  }

  // Méthode 4: strings (fallback basique)
  if (fullText.length < 100) {
    log('Tentative méthode 4: strings...');
    const stringsText = extractTextWithStrings(filePath);
    if (stringsText && stringsText.length > fullText.length) {
      fullText = stringsText;
      log(`Méthode 4 (strings): ${fullText.length} caractères`);
    }
  }

  // Si on n'a toujours pas de texte, abandonner
  if (fullText.length < 50) {
    log('Aucun texte exploitable extrait');
    return null;
  }

  // Debug: afficher les premiers caractères
  log(`Texte total: ${fullText.length} caractères`);
  log(`Aperçu: ${fullText.substring(0, 300).replace(/\n/g, ' | ')}...`);

  // Extraire les données
  const patientInfo = extractPatientInfo(fullText, config);
  const actes = extractActes(fullText, config);

  return {
    patient: patientInfo,
    actes: actes,
    rawText: fullText,
    confidence: (patientInfo.nom ? 25 : 0) +
                (patientInfo.date_naissance ? 25 : 0) +
                (patientInfo.nir ? 25 : 0) +
                (actes.length > 0 ? 25 : 0)
  };
}

/**
 * Construit l'URL avec les paramètres extraits
 */
function buildUrlWithParams(baseUrl, extractedData) {
  const url = new URL(baseUrl);

  if (extractedData) {
    const { patient, actes } = extractedData;

    if (patient.nom) url.searchParams.set('nom', patient.nom);
    if (patient.prenom) url.searchParams.set('prenom', patient.prenom);
    if (patient.date_naissance) url.searchParams.set('date_naissance', patient.date_naissance);
    if (patient.nir) url.searchParams.set('nir', patient.nir);

    // Encoder les actes en JSON
    if (actes && actes.length > 0) {
      url.searchParams.set('actes', JSON.stringify(actes));
    }

    // Source
    url.searchParams.set('source', 'cabflow-desktop');
  }

  return url.toString();
}

module.exports = {
  extractFromPS,
  buildUrlWithParams,
  extractTextFragments,
  extractPatientInfo,
  extractActes
};
