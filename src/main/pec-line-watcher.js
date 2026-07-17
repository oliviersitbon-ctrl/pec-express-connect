/**
 * pec-line-watcher.js
 *
 * Boucle de TRACE Logos à l'envoi en signature. Interroge périodiquement MDD
 * (/api/desktop/pec-line-pending) et, pour chaque PEC partie au patient pour
 * signature dont la ligne n'est pas encore écrite, pose dans le dossier Logos
 * une ligne cliquable :
 *
 *     "PEC XX.XX EUR RAC YY.YY EUR envoye pour signature"
 *
 * On réutilise LogosDevisWriter (writeSignedDoc) : la ligne EST un document
 * cliquable (le PDF du devis) portant ce libellé. Le pivot est le NUMERO de
 * dossier Logos (source_patient_ref du devis lié, propagé à la création de PEC).
 *
 * Robuste : chaque PEC est traitée indépendamment ; on ne marque « écrite »
 * (pec-line-written) qu'après écriture réussie → pas de doublon, retry au
 * prochain tick en cas d'échec.
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

async function downloadDevisPdf(site, token) {
  const url = `${site}/api/public/devis/${encodeURIComponent(token)}/pdf?inline=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`pdf HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`pdf: contenu non-PDF (${buf.length} o)`);
  }
  return buf;
}

/**
 * Écrit la ligne « PEC ... envoye pour signature » dans le dossier Logos.
 * @returns {Promise<boolean>} true si écrite (=> marquable).
 */
async function writePecLine(site, item) {
  const numero = item.logosNumero;
  if (!numero) {
    log(`PEC ${String(item.pecId).slice(0, 8)} sans n° dossier Logos -> ignorée`);
    return false;
  }
  const ref = safeRef(item.devisRef || item.pecId.slice(0, 8));
  const prat = item.praticien || 'OS';
  // Libellé ASCII: "PEC 576.80 EUR RAC 0.00 EUR envoye pour signature"
  const label = `PEC ${eur(item.montant)} EUR RAC ${eur(item.rac)} EUR envoye pour signature`;

  const buf = await downloadDevisPdf(site, item.token);
  const r = await logosWriter.writeSignedDoc(
    numero, buf, `PEC-envoyee-signature-${ref}.pdf`, label, prat,
  );
  if (!r.ok) throw new Error(`écriture ligne PEC Logos KO: ${r.result}`);
  log(`Ligne PEC écrite dans dossier ${numero} (cle=${r.cle}) : "${label}"`);
  return true;
}

async function markWritten(site, apiKey, pecId) {
  try {
    const res = await fetch(`${site}/api/desktop/pec-line-written`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ pecId }),
    });
    if (!res.ok) log(`pec-line-written HTTP ${res.status} (pec ${String(pecId).slice(0, 8)})`);
  } catch (e) {
    log(`pec-line-written exception: ${e.message}`);
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
    log(`${items.length} ligne(s) PEC à écrire dans Logos`);

    // Séquentiel : évite toute contention sur ACTES_2 (l'exe ouvre/ferme le .fic).
    for (const item of items) {
      try {
        const done = await writePecLine(site, item);
        if (done) await markWritten(site, apiKey, item.pecId);
      } catch (e) {
        log(`PEC ${String(item.pecId).slice(0, 8)} -> échec (retry au prochain tick): ${e.message}`);
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
