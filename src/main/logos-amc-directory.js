/**
 * Logos AMC Directory Parser - lit l'annuaire national des mutuelles depuis amc.lgw
 *
 * Format:
 *   - amc.lgw est un ZIP contenant un seul fichier amc.xml
 *   - amc.xml est encode en ISO-8859-1
 *   - Structure: <AMC><amc numeros="0434243085,434243085" ... web="..." adresse="...">OCIANE</amc>...</AMC>
 *   - L'attribut "numeros" contient une liste de numeros AMC separes par virgule (souvent
 *     le meme avec et sans le 0 prefixe)
 *   - Le contenu de la balise <amc> est le NOM de la mutuelle
 *
 * Localisation:
 *   - L'annuaire est dans le repertoire d'installation de Logos (typiquement C:\wlogos1\amc.lgw)
 *   - On le lit une fois et on garde un dictionnaire en memoire {numeroAMC -> nom}
 *
 * Performance:
 *   - ~3000 entrees dans l'annuaire
 *   - Decompression: ~50ms a froid
 *   - Lookup: O(1) via map
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[AMC-DIR] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

let _cache = null; // { map: Map<string, string>, loadedAt: Date, mtime: Date, path: string }

/**
 * Cherche le fichier amc.lgw dans les emplacements connus de Logos.
 */
function findAmcLgw(hintDirs = []) {
  const candidates = [
    ...hintDirs,
    'C:\\wlogos1',
    'C:\\wlogos2',
    'C:\\wlogos3',
    'C:\\LOGOSw',
    'C:\\Logos',
    'C:\\logos_w',
    'D:\\wlogos1',
    'E:\\wlogos1',
    'F:\\wlogos1'
  ];
  for (const dir of candidates) {
    const p = path.join(dir, 'amc.lgw');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Parse le contenu XML de amc.xml en un Map { numeroAMC -> nom }.
 */
function parseAmcXml(xml) {
  const map = new Map();
  // Regex tolerante: extrait <amc ...numeros="..."...>NOM</amc>
  // Le NOM peut contenir des entites HTML (ex: &apos;) qu'on decode.
  const rx = /<amc\s+([^>]*?)>([^<]+)<\/amc>/g;
  let m;
  while ((m = rx.exec(xml)) !== null) {
    const attrsStr = m[1];
    const nameRaw = m[2];
    // Decode entites XML basiques
    const nom = nameRaw
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
    // Extrait l'attribut numeros="..."
    const numerosMatch = attrsStr.match(/numeros="([^"]+)"/);
    if (!numerosMatch) continue;
    // Split par virgule, chaque numero pointe vers le meme nom
    const numeros = numerosMatch[1].split(',').map(n => n.trim()).filter(Boolean);
    for (const num of numeros) {
      // Normalise: enleve les 0 prefixe pour matcher avec les formats varies
      const norm = num.replace(/^0+/, '');
      if (norm) map.set(norm, nom);
      // Garde aussi la version originale au cas ou
      map.set(num, nom);
    }
  }
  return map;
}

/**
 * Charge l'annuaire AMC depuis amc.lgw, decompresse, parse, retourne le Map.
 * Cache le resultat. Si le fichier a ete modifie depuis le dernier load, recharge.
 *
 * @param {string} amcLgwPath - chemin vers amc.lgw (optionnel, sinon auto-detect)
 * @returns {Map<string, string>|null} map numeroAMC -> nom, ou null si echec
 */
function loadDirectory(amcLgwPath = null) {
  // Auto-detect si pas fourni
  if (!amcLgwPath) {
    amcLgwPath = findAmcLgw();
    if (!amcLgwPath) {
      log('amc.lgw introuvable dans les emplacements connus');
      return null;
    }
  }
  if (!fs.existsSync(amcLgwPath)) {
    log('amc.lgw introuvable: ' + amcLgwPath);
    return null;
  }

  // Cache invalidation par mtime
  const stat = fs.statSync(amcLgwPath);
  if (_cache && _cache.path === amcLgwPath && _cache.mtime.getTime() === stat.mtime.getTime()) {
    return _cache.map;
  }

  try {
    const T0 = Date.now();
    const zip = new AdmZip(amcLgwPath);
    const entries = zip.getEntries();
    // Cherche amc.xml dedans
    const xmlEntry = entries.find(e => e.entryName.toLowerCase() === 'amc.xml');
    if (!xmlEntry) {
      log('amc.xml non trouve dans amc.lgw (entries: ' + entries.map(e => e.entryName).join(',') + ')');
      return null;
    }
    // Decompresse en ISO-8859-1
    const rawBuf = zip.readFile(xmlEntry);
    if (!rawBuf) {
      log('Decompression amc.xml a echoue');
      return null;
    }
    const xml = rawBuf.toString('latin1'); // iso-8859-1 ~ latin1
    const map = parseAmcXml(xml);
    _cache = { map, loadedAt: new Date(), mtime: stat.mtime, path: amcLgwPath };
    log(`Annuaire AMC charge: ${map.size} entrees en ${Date.now() - T0}ms (source: ${amcLgwPath})`);
    return map;
  } catch (e) {
    log('Erreur lecture amc.lgw: ' + e.message);
    return null;
  }
}

/**
 * Resout un numero AMC en nom de mutuelle.
 * @param {string} numeroAMC
 * @param {string} amcLgwPath - optionnel
 * @returns {string|null}
 */
function resolveAmcName(numeroAMC, amcLgwPath = null) {
  if (!numeroAMC) return null;
  const map = loadDirectory(amcLgwPath);
  if (!map) return null;
  // Essai direct
  let nom = map.get(String(numeroAMC));
  if (nom) return nom;
  // Essai avec normalisation (enleve les 0 prefixe)
  const norm = String(numeroAMC).replace(/^0+/, '');
  nom = map.get(norm);
  if (nom) return nom;
  return null;
}

module.exports = {
  setLogger,
  findAmcLgw,
  loadDirectory,
  resolveAmcName,
  parseAmcXml // expose pour test
};
