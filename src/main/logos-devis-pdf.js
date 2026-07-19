'use strict';

// Retrouve le PDF officiel du devis genere par Logos.
// Logos ecrit le devis dans : <patientsDir>\LIENS\<patientId>\Devis-<devisId>.pdf
// Quand un devis est re-enregistre, Logos suffixe -2, -3 ... -> on prend le
// fichier le plus RECENT (mtime), pas forcement celui sans suffixe.
//
// NB: ce module ne DECLENCHE pas la generation du PDF (c'est le role de
// l'automatisation Logos, etapes 1-2). Il se contente de lire un PDF DEJA
// present sur le disque. Si aucun PDF n'existe encore, il retourne null et
// l'envoi se fait sans pdfBase64 (comportement actuel, non bloquant).

const fs = require('fs');
const path = require('path');

let log = () => {};
function setLogger(fn) { if (typeof fn === 'function') log = fn; }

/**
 * @param {string} patientsDir - repertoire data Logos (ex: ...\Patients)
 * @param {number|string} patientId
 * @param {number|string} devisId
 * @param {boolean} [preferFreshest] - si vrai, IGNORE le devisId et prend
 *   directement le Devis-*.pdf le plus RECENT du dossier. À utiliser quand on
 *   vient d'imprimer le devis actif (flow PEC) : le devisId lu en mémoire
 *   ("Devis selectionne") peut pointer sur l'ANCIEN devis, alors que le fichier
 *   qu'on vient d'imprimer est forcément le plus récent.
 * @param {number} [sinceMs] - seuil "posterieur au clic". Si fourni, on n'accepte
 *   QUE les PDF dont la date (mtime) est >= sinceMs : le PDF choisi doit avoir
 *   ete cree APRES le clic d'envoi. Evite d'attacher l'ancien devis (perime)
 *   quand la nouvelle impression n'a pas (encore) produit de PDF.
 * @returns {null | { path: string, fileName: string, base64: string, sizeKb: number }}
 */
function findLatestDevisPdf(patientsDir, patientId, devisId, preferFreshest, sinceMs) {
  // En mode preferFreshest, le devisId n'est pas requis (on ne s'en sert pas).
  if (!patientsDir || patientId == null || patientId === '' ||
      (!preferFreshest && (devisId == null || devisId === ''))) {
    log('[DEVIS-PDF] Contexte incomplet (patientsDir/patientId/devisId) - skip');
    return null;
  }

  const dir = path.join(patientsDir, 'LIENS', String(patientId));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    log('[DEVIS-PDF] Dossier LIENS introuvable: ' + dir + ' (' + (e.code || e.message) + ')');
    return null;
  }

  let matches;
  if (preferFreshest) {
    // On vient d'imprimer le devis actif → le PDF le plus RÉCENT est le bon,
    // quel que soit le devisId lu en mémoire (qui peut pointer sur l'ancien
    // devis sélectionné). On ne filtre donc PAS par devisId.
    const reAny = /^Devis-.*\.pdf$/i;
    matches = entries.filter((f) => reAny.test(f));
    log('[DEVIS-PDF] preferFreshest: ' + matches.length +
        ' Devis-*.pdf candidat(s), on retient le plus récent (devisId ignoré)');
  } else {
    // Devis-<devisId>.pdf  OU  Devis-<devisId>-2.pdf ...  (insensible a la casse)
    const re = new RegExp('^Devis-' + String(devisId) + '(?:-\\d+)?\\.pdf$', 'i');
    matches = entries.filter((f) => re.test(f));
    if (!matches.length) {
      // Repli : Logos peut nommer le PDF avec un autre numero que le devisId lu.
      // On prend alors n'importe quel Devis-*.pdf, et le plus RECENT (celui qu'on
      // vient d'enregistrer via Shift+clic imprimante) sera retenu plus bas.
      const reAny = /^Devis-.*\.pdf$/i;
      matches = entries.filter((f) => reAny.test(f));
      if (matches.length) {
        log('[DEVIS-PDF] Pas de Devis-' + devisId + '*.pdf, repli sur le Devis-*.pdf le plus recent (' +
            matches.length + ' candidat(s))');
      }
    }
  }
  if (!matches.length) {
    log('[DEVIS-PDF] Aucun Devis-*.pdf dans ' + dir);
    return null;
  }

  // Le plus recent par date de modification (le -2 peut etre plus recent).
  // Regle anti-devis-perime : si sinceMs est fourni, on IGNORE tout PDF plus
  // ancien que le clic (mtime < sinceMs). Le PDF retenu doit avoir ete genere
  // par l'impression courante, jamais un devis precedent.
  let best = null;
  let rejetesAnciens = 0;
  for (const f of matches) {
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (sinceMs && st.mtimeMs < sinceMs) { rejetesAnciens++; continue; }
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { file: f, full, mtimeMs: st.mtimeMs, size: st.size };
    }
  }
  if (!best) {
    if (sinceMs && rejetesAnciens > 0) {
      log('[DEVIS-PDF] Aucun PDF posterieur au clic (' + rejetesAnciens +
          ' PDF plus ancien(s) ignore(s)) - pas d\'attache perimee');
    } else {
      log('[DEVIS-PDF] Candidats trouves mais aucun fichier lisible/non-vide');
    }
    return null;
  }

  let buf;
  try {
    buf = fs.readFileSync(best.full);
  } catch (e) {
    log('[DEVIS-PDF] Lecture echouee ' + best.full + ': ' + e.message);
    return null;
  }

  // Sanity check leger : un vrai PDF commence par "%PDF".
  if (buf.slice(0, 4).toString('latin1') !== '%PDF') {
    log('[DEVIS-PDF] ATTENTION: ' + best.file + " ne commence pas par %PDF (fichier non-PDF ?)");
  }

  const sizeKb = Math.round(best.size / 1024);
  log('[DEVIS-PDF] PDF retenu: ' + best.file + ' (' + sizeKb + ' Ko, ' +
      matches.length + ' candidat(s))');

  return { path: best.full, fileName: best.file, base64: buf.toString('base64'), sizeKb };
}

/**
 * Liste les Devis-*.pdf du dossier patient, du plus RÉCENT au plus ancien, avec
 * leur base64. Sert à la voie PEC : plutôt que de prendre aveuglément le plus
 * récent, on compare les actes de chaque candidat aux actes lus dans Logos pour
 * attacher LE BON devis (celui affiché), même si le praticien a navigué sur un
 * ancien devis alors qu'un plus récent existe.
 * @returns {Array<{ path, fileName, base64, sizeKb, mtimeMs }>}
 */
function listDevisPdfs(patientsDir, numero, limit = 6) {
  if (!patientsDir || numero == null || numero === '') return [];
  const dir = path.join(patientsDir, 'LIENS', String(numero));
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) {
    log('[DEVIS-PDF] Dossier LIENS introuvable: ' + dir + ' (' + (e.code || e.message) + ')');
    return [];
  }
  const reAny = /^Devis-.*\.pdf$/i;
  const files = [];
  for (const f of entries) {
    if (!reAny.test(f)) continue;
    const full = path.join(dir, f);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size === 0) continue;
    files.push({ file: f, full, mtimeMs: st.mtimeMs, size: st.size });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs); // plus récent d'abord
  const out = [];
  for (const c of files.slice(0, limit)) {
    let buf;
    try { buf = fs.readFileSync(c.full); } catch (e) { continue; }
    out.push({
      path: c.full,
      fileName: c.file,
      base64: buf.toString('base64'),
      sizeKb: Math.round(c.size / 1024),
      mtimeMs: c.mtimeMs,
    });
  }
  log('[DEVIS-PDF] ' + out.length + ' Devis-*.pdf candidat(s) (du plus récent au plus ancien)');
  return out;
}

module.exports = { setLogger, findLatestDevisPdf, listDevisPdfs };
