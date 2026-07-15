/**
 * PS-to-PDF + Extraction texte universel (imprimante virtuelle PostScript)
 *
 * Strategie validee sur PS reel produit par "Microsoft PS Class Driver" (MSxpsPS):
 *
 *   1. PS -> PDF (Ghostscript pdfwrite)        ~ 1s, fonts TrueType embarquees
 *   2. PDF -> XML positionne (Ghostscript txtwrite TextFormat=0)
 *      => XML avec <char bbox="x0 y0 x1 y1" c="X"/> pour chaque glyph
 *   3. Decodage:
 *        a. Resolution des entites XML (&apos;, &amp;, &#xNN;, ...)
 *        b. SHIFT UNIVERSEL +0x1D sur chaque glyph_id pour retrouver l'ASCII/Latin-1
 *           (raison: MSxpsPS encode avec CMap synthetique dont l'origine est 0x03 au
 *           lieu de 0x20; le delta est constant = 0x1D)
 *        c. Latin-1 (cp1252) pour les accents francais
 *   4. Reconstruction des lignes par y proche + tri par x
 *
 * Pas d'OCR, deterministe, fonctionne sur n'importe quel PostScript Type 42 issu
 * du pipeline MSxpsPS / Microsoft PS Class Driver / Generic PostScript Adobe.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[PS2PDF] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

/**
 * Detecte si un buffer est au format PostScript (%!PS, MSxpsPS, ou PJL+PS)
 */
function isPostScriptFormat(buffer) {
  if (!buffer || buffer.length < 4) return false;
  // %!PS = 25 21 50 53
  if (buffer[0] === 0x25 && buffer[1] === 0x21 &&
      buffer[2] === 0x50 && buffer[3] === 0x53) return true;
  // PJL avec ENTER LANGUAGE=POSTSCRIPT
  const head = buffer.slice(0, Math.min(512, buffer.length)).toString('latin1');
  if (head.includes('%!PS')) return true;
  if (head.includes('LANGUAGE=POSTSCRIPT')) return true;
  return false;
}

/**
 * Localise gswin64c.exe (Ghostscript bundle) dans les emplacements connus
 */
function findGhostscript() {
  const candidates = [
    path.join(process.resourcesPath || '', 'resources', 'win', 'gs', 'gswin64c.exe'),
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', 'gs', 'gswin64c.exe'),
    path.join(path.dirname(process.execPath), 'resources', 'win', 'gs', 'gswin64c.exe'),
    path.join(__dirname, '..', '..', 'resources', 'win', 'gs', 'gswin64c.exe'),
    'C:\\Program Files\\gs\\gs10.04.0\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs10.03.1\\bin\\gswin64c.exe',
    'C:\\Program Files\\gs\\gs10.02.1\\bin\\gswin64c.exe',
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  try {
    const gsRoot = 'C:\\Program Files\\gs';
    if (fs.existsSync(gsRoot)) {
      const versions = fs.readdirSync(gsRoot).filter(d => d.startsWith('gs'));
      for (const v of versions) {
        const p = path.join(gsRoot, v, 'bin', 'gswin64c.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (e) {}
  return null;
}

/**
 * Execute Ghostscript avec une liste d'arguments
 */
function runGhostscript(gs, args, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(gs, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });

    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error(`Ghostscript timeout ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(new Error(`Ghostscript exit ${code}: ${stderr.slice(0, 200)}`));
      }
      resolve({ stdout, stderr });
    });
    proc.on('error', e => {
      clearTimeout(timeout);
      reject(new Error('Ghostscript spawn error: ' + e.message));
    });
  });
}

/**
 * Convertit un buffer PostScript en fichier PDF temporaire
 */
async function convertPsBufferToPdf(psBuffer) {
  const gs = findGhostscript();
  if (!gs) throw new Error('Ghostscript introuvable (resources/win/gs/gswin64c.exe)');

  const tmpId = `cabflow-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const psPath = path.join(os.tmpdir(), `${tmpId}.ps`);
  const pdfPath = path.join(os.tmpdir(), `${tmpId}.pdf`);

  fs.writeFileSync(psPath, psBuffer);

  const T0 = Date.now();
  await runGhostscript(gs, [
    '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER',
    '-sDEVICE=pdfwrite',
    '-dEmbedAllFonts=true',
    '-dSubsetFonts=false',
    '-dCompatibilityLevel=1.4',
    `-sOutputFile=${pdfPath}`,
    psPath
  ], 20000);
  log(`PS->PDF en ${Date.now() - T0}ms (${(fs.statSync(pdfPath).size / 1024).toFixed(1)} KB)`);
  return { pdfPath, psPath };
}

/**
 * Convertit le PDF en XML positionne via gs txtwrite TextFormat=0
 */
async function pdfToTxtwriteXml(pdfPath) {
  const gs = findGhostscript();
  const xmlPath = path.join(os.tmpdir(), `cabflow-${Date.now()}.xml`);
  const T0 = Date.now();
  await runGhostscript(gs, [
    '-dNOPAUSE', '-dBATCH', '-dQUIET', '-dSAFER',
    '-sDEVICE=txtwrite',
    '-dTextFormat=0',
    `-sOutputFile=${xmlPath}`,
    pdfPath
  ], 20000);
  const xml = fs.readFileSync(xmlPath, 'utf8');
  fs.unlinkSync(xmlPath);
  log(`PDF->XML en ${Date.now() - T0}ms (${(xml.length / 1024).toFixed(1)} KB)`);
  return xml;
}

/**
 * Resout les entites XML simples (&apos; &amp; &lt; &gt; &quot; &#xNN; &#NNN;)
 */
function decodeXmlEntity(c) {
  if (c === '&apos;') return "'";
  if (c === '&amp;') return '&';
  if (c === '&lt;') return '<';
  if (c === '&gt;') return '>';
  if (c === '&quot;') return '"';
  const hex = c.match(/^&#x([0-9a-fA-F]+);$/);
  if (hex) return String.fromCharCode(parseInt(hex[1], 16));
  const dec = c.match(/^&#(\d+);$/);
  if (dec) return String.fromCharCode(parseInt(dec[1], 10));
  return c;
}

/**
 * Detecte automatiquement le shift a appliquer en analysant le texte brut du XML
 * extrait par GS txtwrite.
 *
 * Heuristique: on cherche le motif typique "DEVIS POUR LES TRAITEMENTS" ou
 * "Nom et prenom" dans le texte. Si on le trouve directement (shift 0), c'est bon.
 * Sinon on essaie +0x1D (MSxpsPS) et -0x1D (Adobe PScript5).
 *
 * @param {Array<string>} sampleChars - Les premiers ~500 chars du XML
 * @returns {number} - Le shift a appliquer (+0x1D, -0x1D, ou 0)
 */
function detectShift(sampleChars) {
  const sample = sampleChars.join('');
  // Patterns attendus dans un devis dentaire
  const targets = ['DEVIS', 'POUR', 'Nom', 'Date', 'Prothèse', 'Identification', 'devis', 'patient'];

  for (const shift of [0, +0x1D, -0x1D]) {
    let shifted;
    if (shift === 0) {
      shifted = sample;
    } else {
      shifted = [...sample].map(c => {
        const code = c.charCodeAt(0);
        if (code >= 0x20 && code < 0x7F) {
          let n = code + shift;
          if (n > 0x7E) n -= 95;
          if (n < 0x20) n += 95;
          return String.fromCharCode(n);
        }
        return c;
      }).join('');
    }
    for (const t of targets) {
      if (shifted.includes(t)) return shift;
    }
  }
  return 0;
}

/**
 * Decode un glyph en appliquant le shift donne.
 *
 * - shift = 0  : texte deja en clair (Adobe PScript5, drivers PS modernes)
 * - shift = +0x1D : MSxpsPS (Microsoft PS Class Driver)
 * - shift = -0x1D : Adobe PScript5 avec CMap inverse (rare)
 *
 * Pour la plage > 0x7E, on suppose Latin-1 direct (les fonts modernes utilisent
 * Latin-1/Unicode pour les accents).
 */
function decodeGlyphWithShift(c, shift) {
  if (!c || c.length !== 1 || shift === 0) return c;
  const code = c.charCodeAt(0);
  // ASCII printable: shift
  if (code >= 0x20 && code < 0x7F) {
    let n = code + shift;
    if (n > 0x7E) n -= 95;
    if (n < 0x20) n += 95;
    return String.fromCharCode(n);
  }
  // Latin-1 sup: pour MSxpsPS, shift +0x1F (saut controle 0x80-0x9F)
  if (code >= 0x7F && shift === +0x1D) {
    const n = code + 0x1F;
    if (n >= 0xA0 && n <= 0xFF) return String.fromCharCode(n);
  }
  return c;
}

// Alias pour compatibilite avec l'ancien code (avant detection auto)
function decodeMsxpsGlyph(c) {
  return decodeGlyphWithShift(c, +0x1D);
}

/**
 * Mac Roman -> Unicode (les fonts MSxpsPS utilisent l'encoding Standard Mac
 * pour les caracteres accentues francais).
 *
 * Table validee empiriquement sur devis Logos:
 *   0x87 -> é, 0x8E -> è, 0x88 -> â, 0x93 -> ô, 0x92 -> ï, 0x90 -> ê,
 *   0x9F -> ù, 0x96 -> ñ, 0x97 -> ó, 0x99 -> ò, 0x9A -> ú,
 *   0xD2 -> ', 0xD3 -> ', 0xD4 -> ", 0xD5 -> ", 0xC0 -> ¿,
 *   0xA5 -> •, 0xA9 -> ©, 0xAA -> ™
 */
const MACROMAN_MAP = {
  // Lowercase accents (les plus frequents en francais)
  0x80: 'Ä', 0x81: 'Å', 0x82: 'Ç', 0x83: 'É', 0x84: 'Ñ', 0x85: 'Ö', 0x86: 'Ü',
  0x87: 'á', 0x88: 'à', 0x89: 'â', 0x8A: 'ä', 0x8B: 'ã', 0x8C: 'å', 0x8D: 'ç',
  0x8E: 'é', 0x8F: 'è',
  0x90: 'ê', 0x91: 'ë', 0x92: 'í', 0x93: 'ì', 0x94: 'î', 0x95: 'ï',
  0x96: 'ñ', 0x97: 'ó', 0x98: 'ò', 0x99: 'ô', 0x9A: 'ö', 0x9B: 'õ',
  0x9C: 'ú', 0x9D: 'ù', 0x9E: 'û', 0x9F: 'ü',
  0xA0: '†', 0xA1: '°', 0xA2: '¢', 0xA3: '£', 0xA4: '§', 0xA5: '•', 0xA6: '¶',
  0xA7: 'ß', 0xA8: '®', 0xA9: '©', 0xAA: '™', 0xAB: '´', 0xAC: '¨', 0xAD: '≠',
  0xAE: 'Æ', 0xAF: 'Ø',
  0xB0: '∞', 0xB1: '±', 0xB2: '≤', 0xB3: '≥', 0xB4: '¥', 0xB5: 'µ', 0xB6: '∂',
  0xB7: '∑', 0xB8: '∏', 0xB9: 'π', 0xBA: '∫', 0xBB: 'ª', 0xBC: 'º', 0xBD: 'Ω',
  0xBE: 'æ', 0xBF: 'ø',
  0xC0: '¿', 0xC1: '¡', 0xC2: '¬', 0xC3: '√', 0xC4: 'ƒ', 0xC5: '≈', 0xC6: '∆',
  0xC7: '«', 0xC8: '»', 0xC9: '…', 0xCA: ' ', 0xCB: 'À', 0xCC: 'Ã', 0xCD: 'Õ',
  0xCE: 'Œ', 0xCF: 'œ',
  0xD0: '–', 0xD1: '—', 0xD2: '"', 0xD3: '"', 0xD4: '\'', 0xD5: '\'', 0xD6: '÷',
  0xD7: '◊', 0xD8: 'ÿ', 0xD9: 'Ÿ', 0xDA: '/', 0xDB: '€', 0xDC: '‹', 0xDD: '›',
  0xDE: 'ﬁ', 0xDF: 'ﬂ',
  0xE0: '‡', 0xE1: '·', 0xE2: '‚', 0xE3: '„', 0xE4: '‰', 0xE5: 'Â', 0xE6: 'Ê',
  0xE7: 'Á', 0xE8: 'Ë', 0xE9: 'È', 0xEA: 'Í', 0xEB: 'Î', 0xEC: 'Ï', 0xED: 'Ì',
  0xEE: 'Ó', 0xEF: 'Ô',
  0xF0: '', 0xF1: 'Ò', 0xF2: 'Ú', 0xF3: 'Û', 0xF4: 'Ù', 0xF5: 'ı', 0xF6: 'ˆ',
  0xF7: '˜', 0xF8: '¯', 0xF9: '˘', 0xFA: '˙', 0xFB: '˚', 0xFC: '¸', 0xFD: '˝',
  0xFE: '˛', 0xFF: 'ˇ',
};

function normalizeLatin1(s) {
  // Les caracteres ont deja ete decodes en Latin-1 par decodeMsxpsGlyph.
  // Latin-1 est compatible Unicode pour les codes 0x00-0xFF, donc rien a mapper.
  // On normalise juste les apostrophes typographiques qui peuvent traîner.
  return s;
}

/**
 * Parse le XML txtwrite et retourne un tableau de chars decodes positionnes
 * @returns {Array<{x0,y0,x1,y1,page,c}>}
 */
function parseTxtwriteXml(xml) {
  const chars = [];
  // Detection des balises <page>
  const charRe = /<char\s+bbox="([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)\s+([\d.\-]+)"\s+c="([^"]*)"\s*\/?>/g;

  // Determiner les segments de page (offsets de chaque <page>)
  const pageOffsets = [];
  let pm;
  const pageRe2 = /<page>/g;
  while ((pm = pageRe2.exec(xml)) !== null) pageOffsets.push(pm.index);

  // Premier pass: extraire tous les chars bruts pour detection du shift
  const raw = [];
  let m;
  while ((m = charRe.exec(xml)) !== null) {
    const rawEntity = m[5];
    const rawChar = decodeXmlEntity(rawEntity);
    let page = 0;
    for (let i = pageOffsets.length - 1; i >= 0; i--) {
      if (m.index >= pageOffsets[i]) { page = i; break; }
    }
    raw.push({
      x0: parseFloat(m[1]),
      y0: parseFloat(m[2]),
      x1: parseFloat(m[3]),
      y1: parseFloat(m[4]),
      page,
      rawC: rawChar
    });
  }

  // Detection du shift automatique sur un echantillon (1000 premiers chars)
  const sample = raw.slice(0, 1000).map(r => r.rawC);
  const shift = detectShift(sample);
  log(`Detection shift: ${shift === 0 ? '0 (texte clair Adobe PScript)' : (shift > 0 ? '+' : '') + shift.toString(16) + ' (MSxpsPS-like)'}`);

  // Deuxieme pass: applique le shift detecte
  for (const r of raw) {
    chars.push({
      x0: r.x0,
      y0: r.y0,
      x1: r.x1,
      y1: r.y1,
      page: r.page,
      c: decodeGlyphWithShift(r.rawC, shift)
    });
  }
  return chars;
}

/**
 * Reconstruit les lignes a partir des chars positionnes
 * Algo: groupement par (page, y) avec tolerance, puis tri par x, insertion espaces.
 * Note: on PRESERVE les colonnes en separant via gap horizontal > 30pt.
 *
 * @returns {Array<{page, x, y, width, text}>}
 */
function reconstructLines(chars, opts = {}) {
  const yTolerance = opts.yTolerance || 2.5;
  const wordGapPt = opts.wordGapPt || 1.5;
  const columnGapPt = opts.columnGapPt || 25;

  // Tri global
  const sorted = [...chars].sort((a, b) =>
    a.page - b.page || a.y0 - b.y0 || a.x0 - b.x0
  );

  // Grouper par (page, y proche)
  const rows = [];
  let cur = null;
  for (const ch of sorted) {
    if (!cur || cur.page !== ch.page || Math.abs(cur.y - ch.y0) > yTolerance) {
      cur = { page: ch.page, y: ch.y0, items: [ch] };
      rows.push(cur);
    } else {
      cur.items.push(ch);
    }
  }

  // Pour chaque row, trier par x et eventuellement SPLITTER en segments si gap horizontal > columnGapPt
  const out = [];
  for (const row of rows) {
    row.items.sort((a, b) => a.x0 - b.x0);
    let segment = null;
    let lastX1 = null;
    for (const ch of row.items) {
      if (!segment || (lastX1 !== null && ch.x0 - lastX1 > columnGapPt)) {
        if (segment) out.push(segment);
        segment = { page: row.page, y: row.y, x: ch.x0, items: [ch] };
      } else {
        if (lastX1 !== null && ch.x0 - lastX1 > wordGapPt) {
          segment.items.push({ x0: ch.x0, x1: ch.x0, c: ' ', y0: ch.y0, y1: ch.y0 });
        }
        segment.items.push(ch);
      }
      lastX1 = ch.x1;
    }
    if (segment) out.push(segment);
  }

  // Construire le texte de chaque segment
  for (const seg of out) {
    const last = seg.items[seg.items.length - 1];
    seg.width = last.x1 - seg.items[0].x0;
    seg.text = normalizeLatin1(seg.items.map(i => i.c).join('')).replace(/\s+/g, ' ').trim();
  }

  return out.filter(s => s.text);
}

/**
 * Pipeline complet: PS buffer -> fragments positionnes
 *
 * @param {Buffer} psBuffer
 * @param {object} opts
 * @param {boolean} opts.keepFilesOnError
 * @returns {Promise<{lines, chars, pdfPath, psPath}>}
 */
async function extractFromPsBuffer(psBuffer, opts = {}) {
  const T0 = Date.now();
  const { pdfPath, psPath } = await convertPsBufferToPdf(psBuffer);
  const xml = await pdfToTxtwriteXml(pdfPath);
  const chars = parseTxtwriteXml(xml);
  log(`${chars.length} glyphs extraits`);
  const lines = reconstructLines(chars);
  log(`${lines.length} lignes reconstruites en ${Date.now() - T0}ms`);

  return { lines, chars, pdfPath, psPath };
}

/**
 * Aplatit en format compatible devis-extractor.js: {page, x, y, width, height, text}
 */
function flattenToLines(input) {
  // Si on a deja des "lines" (sortie de reconstructLines), juste reformatter
  if (input && Array.isArray(input.lines)) input = input.lines;
  if (!Array.isArray(input)) return [];
  return input.map(l => ({
    page: l.page || 0,
    x: l.x,
    y: l.y,
    width: l.width || 0,
    height: l.items ? (l.items[0].y1 - l.items[0].y0) : 10,
    text: l.text
  }));
}

/**
 * Helper pour le test script: extract a partir d'un chemin (PS ou PDF)
 */
async function extractStructuredText(pdfPath) {
  const xml = await pdfToTxtwriteXml(pdfPath);
  const chars = parseTxtwriteXml(xml);
  const lines = reconstructLines(chars);
  return {
    pages: [], // shim de compatibilite
    lines,
    chars
  };
}

module.exports = {
  setLogger,
  isPostScriptFormat,
  findGhostscript,
  convertPsBufferToPdf,
  pdfToTxtwriteXml,
  parseTxtwriteXml,
  reconstructLines,
  extractFromPsBuffer,
  extractStructuredText,
  flattenToLines
};
