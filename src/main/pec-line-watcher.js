/**
 * pec-line-watcher.js
 *
 * Boucle de TRACE Logos à l'envoi en signature. Interroge périodiquement MDD
 * (/api/desktop/pec-line-pending) et, pour chaque PEC partie au patient pour
 * signature, pose dans le dossier Logos DEUX lignes cliquables distinctes :
 *
 *     1. "Devis XX.XX EUR envoye pour signature"           -> PDF joint = DEVIS
 *     2. "PEC XX.XX EUR RAC YY.YY EUR envoye pour signature" -> PDF joint = ACCORD
 *        de prise en charge (document OCAM). Posée UNIQUEMENT quand l'accord est
 *        disponible côté serveur (accordDocId non nul) ; sinon retry au prochain
 *        tick (le devis, lui, est toujours prêt et posé immédiatement).
 *
 * On réutilise LogosDevisWriter (writeSignedDoc) : chaque ligne EST un document
 * cliquable portant ce libellé. Le pivot est le NUMERO de dossier Logos
 * (source_patient_ref du devis lié, propagé à la création de PEC).
 *
 * Robuste : les deux lignes sont indépendantes ; on ne marque une ligne « écrite »
 * (pec-line-written, param `line`) qu'après écriture réussie → pas de doublon,
 * retry au prochain tick en cas d'échec ou d'accord pas encore prêt.
 *
 * ASCII only dans le libellé (« EUR », point décimal, « envoye ») : le champ
 * EXTRA de Logos casse sur les accents (cf. signed-docs-watcher).
 */
const fetch = require('node-fetch');
const { getConfig } = require('./config-manager');
const logosWriter = require('./logos-devis-writer');

let _logger = null;
function setLogger(fn) { _logger = fn; logosWriter.setLogger(fn); }
function log(m) { const s = `[PEC-LINE-WATCHER] ${m}`; if (_logger) _logger(s); else console.log(s); }

const POLL_MS = 30 * 1000;        // toutes les 30 s
const FIRST_DELAY_MS = 12 * 1000; // 12 s après démarrage (décalé du signed-watcher)
let _timer = null;
let _running = false;

function siteAndKey() {
  // Les routes desktop vivent sur le host MDD même pour un cabinet Labora.
  const cfg = getConfig() || {};
  const site = 'https://app.mondevisdentaire.com';
  const apiKey = cfg.apiKey || '';
  return { site, apiKey };
}

function safeRef(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'pec';
}

function eur(n) {
  const v = Number(n);
  return (isFinite(v) ? v : 0).toFixed(2);
}

async function downloadPdf(url, kind) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${kind} HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`${kind}: contenu non-PDF (${buf.length} o)`);
  }
  return buf;
}

function downloadDevisPdf(site, token) {
  return downloadPdf(
    `${site}/api/public/devis/${encodeURIComponent(token)}/pdf?inline=1`, 'devis',
  );
}

function downloadAccordPdf(site, token, accordDocId) {
  return downloadPdf(
    `${site}/api/public/devis/${encodeURIComponent(token)}/ocam-pdf` +
      `?docId=${encodeURIComponent(accordDocId)}&inline=1`,
    'accord',
  );
}

/**
 * Écrit la ligne « Devis ... envoye pour signature » (PDF joint = DEVIS).
 * @returns {Promise<boolean>} true si écrite (=> marquable ligne "devis").
 */
async function writeDevisLine(site, item) {
  const numero = item.logosNumero;
  const ref = safeRef(item.devisRef || item.pecId.slice(0, 8));
  const prat = item.praticien || 'OS';
  // Libellé ASCII: "Devis 1160.50 EUR envoye pour signature"
  const label = `Devis ${eur(item.montant)} EUR envoye pour signature`;

  const buf = await downloadDevisPdf(site, item.token);
  const r = await logosWriter.writeSignedDoc(
    numero, buf, `Devis-envoye-signature-${ref}.pdf`, label, prat,
  );
  if (!r.ok) throw new Error(`écriture ligne devis Logos KO: ${r.result}`);
  log(`Ligne DEVIS écrite dans dossier ${numero} (cle=${r.cle}) : "${label}"`);
  return true;
}

/**
 * Écrit la ligne « PEC ... envoye pour signature » (PDF joint = ACCORD de prise
 * en charge). Nécessite item.accordDocId (accord disponible côté serveur).
 * @returns {Promise<boolean>} true si écrite (=> marquable ligne "pec").
 */
async function writePecLine(site, item) {
  const numero = item.logosNumero;
  const ref = safeRef(item.devisRef || item.pecId.slice(0, 8));
  const prat = item.praticien || 'OS';
  // Libellé ASCII: "PEC 1160.50 EUR RAC 910.50 EUR envoye pour signature"
  const label = `PEC ${eur(item.montant)} EUR RAC ${eur(item.rac)} EUR envoye pour signature`;

  const buf = await downloadAccordPdf(site, item.token, item.accordDocId);
  const r = await logosWriter.writeSignedDoc(
    numero, buf, `PEC-accord-envoye-signature-${ref}.pdf`, label, prat,
  );
  if (!r.ok) throw new Error(`écriture ligne PEC Logos KO: ${r.result}`);
  log(`Ligne PEC (accord) écrite dans dossier ${numero} (cle=${r.cle}) : "${label}"`);
  return true;
}

async function markWritten(site, apiKey, pecId, line) {
  try {
    const res = await fetch(`${site}/api/desktop/pec-line-written`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ pecId, line }),
    });
    if (!res.ok) log(`pec-line-written(${line}) HTTP ${res.status} (pec ${String(pecId).slice(0, 8)})`);
  } catch (e) {
    log(`pec-line-written(${line}) exception: ${e.message}`);
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const { site, apiKey } = siteAndKey();
    if (!apiKey) { return; } // poste pas encore appairé

    const res = await fetch(`${site}/api/desktop/pec-line-pending`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`pec-line-pending HTTP ${res.status} — ${body.slice(0, 150)}`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    const items = (json && json.items) || [];
    if (!items.length) { return; }
    log(`${items.length} PEC avec ligne(s) à écrire dans Logos`);

    // Séquentiel : évite toute contention sur ACTES_2 (l'exe ouvre/ferme le .fic).
    for (const item of items) {
      const short = String(item.pecId).slice(0, 8);
      if (!item.logosNumero) {
        log(`PEC ${short} sans n° dossier Logos -> ignorée`);
        continue;
      }

      // Ligne 1 — DEVIS (toujours disponible). Indépendante de l'accord.
      // needDevisLine peut être absent (ancien serveur) -> on considère à écrire.
      if (item.needDevisLine !== false) {
        try {
          if (await writeDevisLine(site, item)) {
            await markWritten(site, apiKey, item.pecId, 'devis');
          }
        } catch (e) {
          log(`PEC ${short} ligne devis -> échec (retry): ${e.message}`);
        }
      }

      // Ligne 2 — PEC / ACCORD. Écrite seulement si l'accord est prêt.
      if (item.needPecLine !== false) {
        if (!item.accordDocId) {
          log(`PEC ${short} : accord pas encore disponible -> ligne PEC en attente (retry)`);
        } else {
          try {
            if (await writePecLine(site, item)) {
              await markWritten(site, apiKey, item.pecId, 'pec');
            }
          } catch (e) {
            log(`PEC ${short} ligne PEC(accord) -> échec (retry): ${e.message}`);
          }
        }
      }
    }
  } catch (e) {
    log(`tick exception: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start(logFn) {
  if (logFn) setLogger(logFn);
  if (_timer) return;
  log(`Démarrage (poll ${POLL_MS / 1000}s)`);
  setTimeout(() => { tick(); _timer = setInterval(tick, POLL_MS); }, FIRST_DELAY_MS);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function runNow() { return tick(); }

module.exports = { start, stop, runNow, setLogger };
