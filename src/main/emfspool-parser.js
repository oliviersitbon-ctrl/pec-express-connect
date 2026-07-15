/**
 * EMFSPOOL Parser - Extraction de texte depuis les fichiers spool Windows
 *
 * Les applications Windows natives (Logos, Julie, Visiodent, Notepad...)
 * utilisent GDI TextOut/ExtTextOut qui produit des records EMR_EXTTEXTOUTW
 * dans les fichiers EMFSPOOL (.SPL).
 *
 * Ce module parse ces records pour extraire le texte Unicode avec positions,
 * et reconstruit les lignes pour produire un format compatible avec l'API.
 *
 * Format EMFSPOOL: header 00 00 01 00, contient des EMF embarques.
 * Chaque EMF = une page avec des records EMR_EXTTEXTOUTW (type 0x54).
 */

let _logger = null;
function setLogger(loggerFn) { _logger = loggerFn; }
function log(message) {
  const msg = `[EMFSPOOL] ${message}`;
  if (_logger) _logger(msg);
  else console.log(msg);
}

/**
 * Verifie si un buffer est au format EMFSPOOL
 */
function isEmfSpoolFormat(buffer) {
  if (!buffer || buffer.length < 8) return false;
  return buffer[0] === 0x00 && buffer[1] === 0x00 && buffer[2] === 0x01 && buffer[3] === 0x00;
}

/**
 * Extrait le nom du document depuis le header EMFSPOOL
 */
function extractDocName(buf) {
  try {
    if (buf.length < 20) return null;
    // Le nom du document est en UTF-16LE apres le header
    // Offset typique: 0x10 (16 bytes)
    const headerSize = buf.readUInt32LE(4);
    const docNameOffset = buf.readUInt32LE(8);
    if (docNameOffset >= headerSize || docNameOffset < 12) return null;

    let docName = '';
    for (let i = docNameOffset; i < Math.min(headerSize, buf.length) - 1; i += 2) {
      const charCode = buf.readUInt16LE(i);
      if (charCode === 0) break;
      docName += String.fromCharCode(charCode);
    }
    return docName || null;
  } catch (e) {
    return null;
  }
}

/**
 * Trouve tous les EMF embarques dans le buffer EMFSPOOL
 * Cherche EMR_HEADER (type=1) avec signature " EMF" a offset +40
 */
function findEmfPages(buf) {
  const pages = [];
  for (let i = 0; i < buf.length - 44; i += 4) {
    if (buf.readUInt32LE(i) === 1) {
      const recSize = buf.readUInt32LE(i + 4);
      if (recSize >= 88 && recSize < 100000 && (i + 43) < buf.length) {
        // Signature " EMF" (0x20 0x45 0x4D 0x46) a offset +40
        if (buf[i + 40] === 0x20 && buf[i + 41] === 0x45 && buf[i + 42] === 0x4D && buf[i + 43] === 0x46) {
          pages.push(i);
        }
      }
    }
  }
  return pages;
}

/**
 * Extrait les dimensions de page depuis l'EMR_HEADER
 * rclFrame est en 0.01mm, on convertit en points (1pt = 1/72 inch = 0.3528mm)
 */
function getPageDimensions(buf, emfStart) {
  try {
    // EMR_HEADER structure:
    // +8: rclBounds (16 bytes: left, top, right, bottom) - en pixels device
    // +24: rclFrame (16 bytes: left, top, right, bottom) - en 0.01mm
    const frameLeft = buf.readInt32LE(emfStart + 24);
    const frameTop = buf.readInt32LE(emfStart + 28);
    const frameRight = buf.readInt32LE(emfStart + 32);
    const frameBottom = buf.readInt32LE(emfStart + 36);

    // Convertir 0.01mm en points (1 pt = 25.4/72 * 100 = 35.28 unites 0.01mm)
    const widthPt = Math.round((frameRight - frameLeft) * 72 / 2540);
    const heightPt = Math.round((frameBottom - frameTop) * 72 / 2540);

    if (widthPt > 0 && heightPt > 0 && widthPt < 10000 && heightPt < 10000) {
      return { width: widthPt, height: heightPt };
    }
  } catch (e) { /* fallback */ }

  // Fallback A4
  return { width: 595, height: 842 };
}

/**
 * Parse EMR_EXTTEXTOUTW record (type 0x54)
 */
function parseExtTextOutW(buf, pos, recordSize) {
  if (recordSize < 76) return null;
  try {
    const x = buf.readInt32LE(pos + 36);
    const y = buf.readInt32LE(pos + 40);
    const nChars = buf.readUInt32LE(pos + 44);
    const offString = buf.readUInt32LE(pos + 48);
    const fOptions = buf.readUInt32LE(pos + 52);

    if (nChars === 0 || nChars > 10000) return null;
    if (offString < 76 || offString >= recordSize) return null;

    const strStart = pos + offString;
    const strEnd = strStart + nChars * 2;
    if (strEnd > pos + recordSize || strEnd > buf.length) return null;

    const text = buf.slice(strStart, strEnd).toString('utf16le');
    const isGlyphIndex = (fOptions & 0x0010) !== 0;

    return { text, x, y, nChars, isGlyphIndex };
  } catch (e) {
    return null;
  }
}

/**
 * Parse EMR_SMALLTEXTOUT record (type 0x6C)
 */
function parseSmallTextOut(buf, pos, recordSize) {
  if (recordSize < 28) return null;
  try {
    const x = buf.readInt32LE(pos + 8);
    const y = buf.readInt32LE(pos + 12);
    const nChars = buf.readUInt32LE(pos + 16);
    const fuOptions = buf.readUInt32LE(pos + 20);

    if (nChars === 0 || nChars > 10000) return null;

    let textOffset = 28;
    if (fuOptions & 0x0100) {
      // ASCII
      if (pos + textOffset + nChars > buf.length) return null;
      const text = buf.slice(pos + textOffset, pos + textOffset + nChars).toString('ascii');
      return { text, x, y, nChars, isGlyphIndex: false };
    } else {
      // Unicode
      if (pos + textOffset + nChars * 2 > buf.length) return null;
      const text = buf.slice(pos + textOffset, pos + textOffset + nChars * 2).toString('utf16le');
      return { text, x, y, nChars, isGlyphIndex: false };
    }
  } catch (e) {
    return null;
  }
}

/**
 * Parse tous les records EMF d'une page
 */
function parseEmfRecords(buf, emfStart) {
  const textRecords = [];
  let pos = emfStart;
  let recordCount = 0;

  while (pos + 8 <= buf.length) {
    const recordType = buf.readUInt32LE(pos);
    const recordSize = buf.readUInt32LE(pos + 4);

    if (recordSize < 8 || recordSize > buf.length - pos) break;
    recordCount++;

    // EMR_EXTTEXTOUTW = 0x54
    if (recordType === 0x54) {
      const rec = parseExtTextOutW(buf, pos, recordSize);
      if (rec) textRecords.push(rec);
    }

    // EMR_SMALLTEXTOUT = 0x6C
    if (recordType === 0x6C) {
      const rec = parseSmallTextOut(buf, pos, recordSize);
      if (rec) textRecords.push(rec);
    }

    // EMR_EOF = 0x0E
    if (recordType === 0x0E) break;

    pos += recordSize;
  }

  return { textRecords, recordCount };
}

/**
 * Reconstruit les lignes de texte a partir des records avec positions
 * Groupe par Y (tolerance), trie par X, concatene avec espaces
 */
function reconstructLines(textRecords) {
  // Filtrer les glyph indices et le texte vide
  const validRecords = textRecords.filter(r => {
    if (r.isGlyphIndex) return false;
    if (!r.text || !r.text.trim()) return false;
    // Filtrer les caracteres de controle
    if (r.text.replace(/[\x00-\x1F\x7F-\x9F]/g, '').trim().length === 0) return false;
    return true;
  });

  if (validRecords.length === 0) return [];

  // Trier par Y puis X
  validRecords.sort((a, b) => a.y !== b.y ? a.y - b.y : a.x - b.x);

  // Grouper par ligne (tolerance Y de 5 unites)
  const Y_TOLERANCE = 5;
  const lines = [];
  let currentLine = [validRecords[0]];

  for (let i = 1; i < validRecords.length; i++) {
    const rec = validRecords[i];
    const lastRec = currentLine[currentLine.length - 1];

    if (Math.abs(rec.y - lastRec.y) <= Y_TOLERANCE) {
      currentLine.push(rec);
    } else {
      lines.push(currentLine);
      currentLine = [rec];
    }
  }
  lines.push(currentLine);

  // Construire les elements de sortie
  return lines.map(lineRecords => {
    // Trier par X
    lineRecords.sort((a, b) => a.x - b.x);

    // Concatener le texte avec espaces intelligents
    let text = '';
    let prevX = null;
    let prevText = '';

    for (const rec of lineRecords) {
      if (prevX !== null) {
        // Estimer la largeur d'un caractere (~8 unites pour du texte standard)
        const gap = rec.x - prevX;
        const estimatedCharWidth = prevText.length > 0 ? 8 : 8;
        const expectedEnd = prevX + prevText.length * estimatedCharWidth;
        const actualGap = rec.x - expectedEnd;

        if (actualGap > estimatedCharWidth * 0.5) {
          text += ' ';
        }
      }
      text += rec.text;
      prevX = rec.x;
      prevText = rec.text;
    }

    const minX = Math.min(...lineRecords.map(r => r.x));
    const maxX = Math.max(...lineRecords.map(r => r.x));
    const avgY = Math.round(lineRecords.reduce((s, r) => s + r.y, 0) / lineRecords.length);

    return {
      text: text.trim(),
      x: Math.round(minX),
      y: Math.round(avgY),
      w: Math.round(maxX - minX + 100), // estimation largeur
      h: 12, // hauteur de ligne par defaut
      fontSize: 0
    };
  }).filter(el => el.text.length > 0);
}

/**
 * Point d'entree principal: parse un buffer EMFSPOOL et retourne les donnees
 * au format API { pages: [{ page, width, height, elements: [{ text, x, y, w, h, fontSize }] }] }
 */
function parseEmfSpoolBuffer(buffer) {
  if (!isEmfSpoolFormat(buffer)) {
    log('Buffer non EMFSPOOL (header: ' + buffer.slice(0, 4).toString('hex') + ')');
    return null;
  }

  const docName = extractDocName(buffer);
  log('Document: ' + (docName || '(inconnu)'));

  const emfPages = findEmfPages(buffer);
  log('Pages EMF trouvees: ' + emfPages.length);

  if (emfPages.length === 0) {
    log('Aucune page EMF dans le spool');
    return null;
  }

  const pages = [];

  for (let pageIdx = 0; pageIdx < emfPages.length; pageIdx++) {
    const emfStart = emfPages[pageIdx];
    const dims = getPageDimensions(buffer, emfStart);
    const { textRecords, recordCount } = parseEmfRecords(buffer, emfStart);

    log('Page ' + (pageIdx + 1) + ': ' + recordCount + ' records EMF, ' + textRecords.length + ' records texte');

    const elements = reconstructLines(textRecords);
    log('Page ' + (pageIdx + 1) + ': ' + elements.length + ' lignes reconstruites');

    pages.push({
      page: pageIdx + 1,
      width: dims.width,
      height: dims.height,
      elements
    });
  }

  const totalElements = pages.reduce((s, p) => s + p.elements.length, 0);
  log('Total: ' + pages.length + ' pages, ' + totalElements + ' elements');

  return { pages, docName };
}

module.exports = {
  setLogger,
  isEmfSpoolFormat,
  parseEmfSpoolBuffer
};
