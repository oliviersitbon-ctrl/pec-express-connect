'use strict';

/**
 * fse-parser.js — décodage d'une Feuille de Soins Électronique (SESAM-Vitale).
 *
 * Un fichier .FSE = enregistrements TEXTE à champs fixes (norme SESAM) suivis
 * d'une signature PKCS7 binaire (certificats), séparés par un marqueur "~~~".
 *
 * Pour le module Trust on n'a besoin que de deux choses, validées sur 50 FSE
 * réelles :
 *   - le NIR du patient (entête)       → pour retrouver ses coordonnées (CIVIL.FIC)
 *   - la/les DATE(S) d'acte (AAMMJJ)   → pour le déclencheur « acte du jour même »
 *
 * Entête : "<cat><numeroAM(9)> <NIR(15)><numFSE(9)>…"
 * Actes  : la date AAMMJJ précède immédiatement le code d'acte (2 lettres),
 *          ex. "…0440026652019250708AXI…" → 250708 = 08/07/2025, code AXI.
 * On ne garde que les dates plausibles (année 20xx, mois 01-12, jour 01-31),
 * ce qui écarte les faux positifs venant du numéro de FSE (année « 00 »).
 */

const fs = require('fs');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(m) { const s = `[FSE] ${m}`; if (_logger) _logger(s); else console.log(s); }

/** Partie TEXTE utile (avant la signature binaire PKCS7). */
function textPart(buf) {
  const i = buf.indexOf('~~~');
  const b = i > 0 ? buf.slice(0, i) : buf;
  return b.toString('latin1');
}

function ymdToIso(d) { return `20${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}`; }

function validYmd(d) {
  const yy = +d.slice(0, 2), mm = +d.slice(2, 4), dd = +d.slice(4, 6);
  return yy >= 20 && yy <= 40 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31;
}

/**
 * Parse un fichier FSE.
 * @returns {{numeroAM:string|null, nir:string|null, fseNumber:string|null, acteDates:string[]}|null}
 */
function parseFse(filePath) {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (e) { log('lecture échec ' + filePath + ': ' + e.message); return null; }
  const t = textPart(buf);

  const m = /^.?(\d{9}) (\d{15})(\d{9})/.exec(t);
  const numeroAM = m ? m[1] : null;
  const nir = m ? m[2] : null;
  const fseNumber = m ? m[3] : null;

  const dates = new Set();
  const re = /(\d{6})[A-Z]{2}/g;
  let mm2;
  while ((mm2 = re.exec(t))) {
    const d = mm2[1];
    if (validYmd(d)) dates.add(ymdToIso(d));
  }
  return { numeroAM, nir, fseNumber, acteDates: [...dates].sort() };
}

/** true si la FSE contient au moins un acte à la date ISO donnée (YYYY-MM-DD). */
function hasActeOnDate(parsed, isoDate) {
  return !!parsed && Array.isArray(parsed.acteDates) && parsed.acteDates.includes(isoDate);
}

module.exports = { setLogger, parseFse, hasActeOnDate, textPart };
