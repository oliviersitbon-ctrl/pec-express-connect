/**
 * XPS Parser - Extraction de texte depuis les fichiers SPL au format XPS/ZIP
 *
 * Les imprimantes Windows modernes (Microsoft Print to PDF) produisent des fichiers
 * spool au format XPS (XML Paper Specification), qui est un ZIP contenant des fichiers
 * .fpage en XML. Le texte est stocké dans les attributs UnicodeString des éléments <Glyphs>.
 *
 * Ce parser résout le problème documenté dans PLAN-WINDOWS-FIX.md :
 * MXDC vectorise le texte → mais l'attribut UnicodeString reste lisible dans le XML XPS.
 */

const AdmZip = require('adm-zip');

// Logger injectable
let _logger = null;
function setLogger(loggerFn) {
  _logger = loggerFn;
}
function log(msg) {
  const m = `[XPS] ${msg}`;
  if (_logger) _logger(m);
  else console.log(m);
}

/**
 * Vérifie si un buffer est au format XPS (ZIP avec header PK)
 */
function isXpsSpoolFormat(buffer) {
  if (!buffer || buffer.length < 4) return false;
  return buffer[0] === 0x50 && buffer[1] === 0x4B && buffer[2] === 0x03 && buffer[3] === 0x04;
}

/**
 * Décode les entités HTML/XML dans le texte
 */
function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

/**
 * Extrait les attributs d'un tag XML (simplifié)
 */
function extractAttributes(tagStr) {
  const attrs = {};
  const regex = /(\w[\w:.]*)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = regex.exec(tagStr)) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}

/**
 * Parse une page XPS (.fpage) et retourne les éléments de texte avec positions
 */
function parseFpage(xml) {
  const elements = [];

  // Extraire tous les éléments <Glyphs ... />
  const glyphsRegex = /<Glyphs\s([^>]*?)(?:\/>|>)/gs;
  let match;

  while ((match = glyphsRegex.exec(xml)) !== null) {
    const attrs = extractAttributes(match[1]);
    const text = attrs['UnicodeString'];
    if (!text || !text.trim()) continue;

    const decoded = decodeEntities(text.trim());
    if (!decoded) continue;

    const x = parseFloat(attrs['OriginX'] || attrs['originX'] || '0');
    const y = parseFloat(attrs['OriginY'] || attrs['originY'] || '0');
    const fontSize = parseFloat(attrs['FontRenderingEmSize'] || attrs['fontRenderingEmSize'] || '0');

    elements.push({ text: decoded, x: Math.round(x), y: Math.round(y), fontSize: Math.round(fontSize) });
  }

  return elements;
}

/**
 * Regroupe les éléments par lignes (même Y ± tolérance) et les trie par X
 */
function groupIntoLines(elements, yTolerance = 3) {
  if (!elements.length) return [];

  const sorted = [...elements].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  let currentLine = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const prev = currentLine[currentLine.length - 1];
    if (Math.abs(sorted[i].y - prev.y) <= yTolerance) {
      currentLine.push(sorted[i]);
    } else {
      lines.push(currentLine.sort((a, b) => a.x - b.x));
      currentLine = [sorted[i]];
    }
  }
  if (currentLine.length) lines.push(currentLine.sort((a, b) => a.x - b.x));

  return lines;
}

/**
 * Parse un buffer SPL au format XPS et retourne le texte extrait
 * @param {Buffer} buffer - Buffer du fichier SPL
 * @returns {{ pages: Array, textLines: string[], textElements: Array } | null}
 */
function parseXpsSpoolBuffer(buffer) {
  if (!isXpsSpoolFormat(buffer)) return null;

  try {
    const zip = new AdmZip(buffer);
    const entries = zip.getEntries();

    // Trouver toutes les pages .fpage triées par numéro
    const pageEntries = entries
      .filter(e => e.entryName.match(/Pages\/\d+\.fpage$/i))
      .sort((a, b) => {
        const na = parseInt(a.entryName.match(/(\d+)\.fpage$/)[1]);
        const nb = parseInt(b.entryName.match(/(\d+)\.fpage$/)[1]);
        return na - nb;
      });

    log(`${pageEntries.length} page(s) trouvée(s) dans le XPS`);

    const allPages = [];
    const allElements = [];

    for (let i = 0; i < pageEntries.length; i++) {
      const xml = pageEntries[i].getData().toString('utf8');
      const elements = parseFpage(xml);
      const lines = groupIntoLines(elements);

      allPages.push({ page: i + 1, elements, lines });
      allElements.push(...elements);
    }

    // Construire le texte plat ligne par ligne
    const textLines = [];
    for (const page of allPages) {
      for (const line of page.lines) {
        const lineText = line.map(e => e.text).join(' ');
        if (lineText.trim()) textLines.push(lineText.trim());
      }
    }

    log(`Extraction XPS: ${allElements.length} éléments, ${textLines.length} lignes`);

    return {
      pages: allPages,
      textLines,
      textElements: allElements,
      pageCount: pageEntries.length
    };

  } catch (e) {
    log(`Erreur parse XPS: ${e.message}`);
    return null;
  }
}

module.exports = {
  setLogger,
  isXpsSpoolFormat,
  parseXpsSpoolBuffer
};
