/**
 * questionnaire-watcher.js
 *
 * Boucle de RETOUR des questionnaires médicaux remplis. Interroge périodiquement
 * MDD (/api/desktop/questionnaire-pending?source=logos), télécharge le PDF du
 * questionnaire rempli et le réécrit dans le dossier LogosW d'origine (document
 * cliquable), puis marque l'entrée « archivée ».
 *
 * Règle métier : « si le questionnaire part de Logos, il revient dans Logos ».
 * Le pivot est source_patient_ref (= NUMERO du dossier LogosW), propagé à l'envoi
 * par le bouton « Questionnaire MD ». Les questionnaires envoyés depuis Doctolib
 * (source_system='doctolib') ne sont PAS pris par ce watcher (filtre ?source=logos).
 *
 * Robuste : chaque questionnaire est traité indépendamment ; en cas d'échec on NE
 * marque PAS archivé -> nouvelle tentative au prochain tick (pas de doublon).
 *
 * Multi-poste : AVANT d'écrire, on réserve le questionnaire via un bail atomique
 * (/api/desktop/questionnaire-claim, comme devis/PEC). Un seul poste gagne ->
 * pas de double écriture du PDF quand plusieurs postes tournent en parallèle.
 */
const fetch = require('node-fetch');
const os = require('os');
const { getConfig } = require('./config-manager');
const logosWriter = require('./logos-devis-writer');

// Identifiant du poste (nom machine) : sert au bail multi-poste (claim atomique).
const POST_ID = os.hostname();

let _logger = null;
function setLogger(fn) { _logger = fn; logosWriter.setLogger(fn); }
function log(m) { const s = `[QUESTIONNAIRE-WATCHER] ${m}`; if (_logger) _logger(s); else console.log(s); }

const POLL_MS = 30 * 1000;
const FIRST_DELAY_MS = 10 * 1000;
let _timer = null;
let _running = false;

function siteAndKey() {
  const cfg = getConfig() || {};
  // Les routes /api/desktop/* et /api/public/questionnaire/* vivent sur le host
  // MDD, même pour un cabinet Labora (la façade laboradental.fr ne les sert pas).
  const site = 'https://app.mondevisdentaire.com';
  const apiKey = cfg.apiKey || '';
  return { site, apiKey };
}

function safeRef(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'questionnaire';
}

async function downloadPdf(site, token) {
  const url = `${site}/api/public/questionnaire/${encodeURIComponent(token)}/pdf?inline=1`;
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
 * Réécrit un questionnaire rempli dans le dossier LogosW d'origine.
 * @returns {Promise<boolean>} true si écrit (=> archivable)
 */
async function returnToLogos(site, item) {
  const numero = item.sourcePatientRef;
  if (!numero) {
    log(`Questionnaire ${String(item.token).slice(0, 8)} sans n° dossier Logos -> ignoré`);
    return false;
  }
  const ref = safeRef(item.patientNom || String(item.token).slice(0, 8));
  // Auteur du document Logos : code praticien fourni par le serveur si présent,
  // sinon null -> writeSignedDoc retombe sur le code praticien de LOGOS_w.INI
  // (portable) plutôt que 'OS' en dur.
  const prat = item.praticien || null;
  const buf = await downloadPdf(site, item.token);
  const r = await logosWriter.writeSignedDoc(
    numero, buf, `Questionnaire-medical-${ref}.pdf`, 'Questionnaire medical rempli', prat
  );
  if (!r || !r.ok) throw new Error(`écriture questionnaire Logos KO: ${r && r.result}`);
  log(`Questionnaire rempli écrit dans dossier ${numero} (cle=${r.cle})`);
  return true;
}

/**
 * Bail atomique multi-poste : réserve le questionnaire avant de réécrire le PDF
 * dans Logos. true = ce poste gagne et écrit ; false = déjà pris par un autre
 * (ou erreur réseau : on n'écrit pas si on n'a pas pu réserver -> pas de doublon).
 */
async function claimQuestionnaire(site, apiKey, token) {
  try {
    const res = await fetch(`${site}/api/desktop/questionnaire-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ token, postId: POST_ID }),
    });
    if (!res.ok) { log(`questionnaire-claim HTTP ${res.status} (token ${String(token).slice(0, 8)})`); return false; }
    const j = await res.json().catch(() => ({}));
    return !!(j && j.claimed);
  } catch (e) {
    log(`questionnaire-claim exception: ${e.message}`);
    return false;
  }
}

async function markArchived(site, apiKey, token) {
  try {
    const res = await fetch(`${site}/api/desktop/questionnaire-archived`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) log(`questionnaire-archived HTTP ${res.status} (token ${String(token).slice(0, 8)})`);
  } catch (e) {
    log(`questionnaire-archived exception: ${e.message}`);
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const { site, apiKey } = siteAndKey();
    if (!apiKey) return; // poste pas encore appairé
    // Garde-fou d'appairage : poste en attente/refusé -> aucune écriture Logos.
    try { if (require('./poste-gate').isBlocked()) return; } catch (e) {}

    const res = await fetch(`${site}/api/desktop/questionnaire-pending?source=logos`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`questionnaire-pending HTTP ${res.status} — ${body.slice(0, 150)}`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    const items = (json && json.items) || [];
    if (!items.length) return; // rien à renvoyer (silencieux pour ne pas spammer le log)
    log(`${items.length} questionnaire(s) rempli(s) à renvoyer dans Logos`);

    // Séquentiel : évite la contention sur le .fic Logos (l'exe ouvre/ferme).
    for (const item of items) {
      try {
        // Réservation atomique : un seul poste écrit ce questionnaire.
        if (!(await claimQuestionnaire(site, apiKey, item.token))) {
          log(`Questionnaire ${String(item.token).slice(0, 8)} déjà réservé par un autre poste -> skip`);
          continue;
        }
        const done = await returnToLogos(site, item);
        if (done) await markArchived(site, apiKey, item.token);
      } catch (e) {
        log(`Questionnaire ${String(item.token).slice(0, 8)} -> échec (retry): ${e.message}`);
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

function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }
function runNow() { return tick(); }

module.exports = { start, stop, runNow, setLogger };
