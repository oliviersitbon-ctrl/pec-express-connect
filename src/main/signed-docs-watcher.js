/**
 * signed-docs-watcher.js
 *
 * Boucle de RETOUR des documents signés. Interroge périodiquement MDD
 * (/api/desktop/signed-pending), télécharge le devis signé + le consentement,
 * et les réécrit dans le système d'ORIGINE du devis :
 *   - source_system = "logos"    -> LogosDevisWriter (document cliquable Logos)
 *   - source_system = "doctolib" -> (à venir) voie extension/documents
 *
 * Règle métier : « si le devis part de Logos il revient dans Logos ». Le pivot
 * est source_patient_ref (= NUMERO du dossier Logos), propagé à l'envoi.
 *
 * Robuste : chaque devis est traité indépendamment ; en cas d'échec on NE marque
 * PAS archivé -> nouvelle tentative au prochain tick. mark-archived n'est appelé
 * qu'après réécriture réussie, ce qui évite les doublons dans le dossier.
 */
const os = require('os');
const fetch = require('node-fetch');
const { getConfig } = require('./config-manager');
const logosWriter = require('./logos-devis-writer');

// Identifiant du poste (nom machine) : sert au bail multi-poste (claim atomique).
const POST_ID = os.hostname();

let _logger = null;
function setLogger(fn) { _logger = fn; logosWriter.setLogger(fn); }
function log(m) { const s = `[SIGNED-WATCHER] ${m}`; if (_logger) _logger(s); else console.log(s); }

const POLL_MS = 30 * 1000;       // toutes les 30 s (pourra etre remonte en prod)
const FIRST_DELAY_MS = 8 * 1000;  // 8 s après démarrage
let _timer = null;
let _running = false;

function siteAndKey() {
  const cfg = getConfig() || {};
  // API + endpoints de retour + PDF signes vivent sur le host MDD, meme pour un
  // cabinet Labora (la facade laboradental.fr ne sert pas ces routes -> 405).
  const site = 'https://app.mondevisdentaire.com';
  const apiKey = cfg.apiKey || '';
  return { site, apiKey };
}

function safeRef(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40) || 'devis';
}

async function downloadPdf(site, token, kind) {
  // kind: 'pdf' (devis signé) ou 'consent-pdf' (consentement)
  const url = `${site}/api/public/devis/${encodeURIComponent(token)}/${kind}?inline=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${kind} HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`${kind}: contenu non-PDF (${buf.length} o)`);
  }
  return buf;
}

async function downloadOcamPdf(site, token, docId) {
  // Document OCAM signé (Demande / Accord) servi par docId, validé côté serveur
  // (appartenance à la PEC de ce token).
  const url = `${site}/api/public/devis/${encodeURIComponent(token)}/ocam-pdf?docId=${encodeURIComponent(docId)}&inline=1`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ocam-pdf HTTP ${res.status}`);
  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);
  if (!buf.length || buf.slice(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`ocam-pdf: contenu non-PDF (${buf.length} o)`);
  }
  return buf;
}

/**
 * Réécrit un devis signé (+ consentement) dans Logos.
 * @returns {Promise<boolean>} true si tout est écrit (=> archivable)
 */
async function returnToLogos(site, item) {
  const numero = item.sourcePatientRef;
  if (!numero) {
    log(`Devis ${item.token.slice(0, 8)} sans n° dossier Logos (source_patient_ref) -> ignoré`);
    return false;
  }
  const ref = safeRef(item.devisRef || item.token.slice(0, 8));
  const prat = item.praticien || 'OS';
  // NB : on n'ajoute PLUS le montant du devis au libellé des documents réécrits
  // dans Logos (devis / consentement / accord PEC). Il n'a pas de sens sur le
  // consentement ni l'accord (documents non facturés) et prêtait à confusion.

  // 1) Devis signé — seulement s'il existe un PDF signé (une PEC peut n'avoir
  // que ses documents OCAM à renvoyer, sans devis PDF source).
  if (item.hasSignedDevis) {
    const devisBuf = await downloadPdf(site, item.token, 'pdf');
    const rDevis = await logosWriter.writeSignedDoc(
      numero, devisBuf, `Devis-signe-${ref}.pdf`, 'Devis signe', prat
    );
    if (!rDevis.ok) throw new Error(`écriture devis Logos KO: ${rDevis.result}`);
    log(`Devis signé écrit dans dossier ${numero} (cle=${rDevis.cle})`);
  } else {
    log(`Pas de devis PDF signé pour ${item.token.slice(0, 8)} — on écrit consentement + docs OCAM`);
  }

  // 2) Consentement (si présent)
  if (item.hasConsent) {
    const consBuf = await downloadPdf(site, item.token, 'consent-pdf');
    const rCons = await logosWriter.writeSignedDoc(
      numero, consBuf, `Consentement-signe-${ref}.pdf`, 'Consentement signe', prat
    );
    if (!rCons.ok) throw new Error(`écriture consentement Logos KO: ${rCons.result}`);
    log(`Consentement écrit dans dossier ${numero} (cle=${rCons.cle})`);
  }

  // 3) Documents OCAM signés (Demande + Accord de prise en charge), s'il y en a.
  // Même mécanisme que devis/consentement : un document cliquable par PDF dans le
  // dossier Logos. Libellé ASCII (accents cassent le champ EXTRA).
  const ocamDocs = Array.isArray(item.ocamDocs) ? item.ocamDocs : [];
  for (let i = 0; i < ocamDocs.length; i++) {
    const od = ocamDocs[i];
    if (!od || !od.docId) continue;
    const buf = await downloadOcamPdf(site, item.token, od.docId);
    const asciiLabel = String(od.label || 'Document PEC signe')
      .normalize('NFD').replace(/[̀-ͯ]/g, '');
    const rOcam = await logosWriter.writeSignedDoc(
      numero, buf, `PEC-doc-signe-${ref}-${i + 1}.pdf`, asciiLabel, prat
    );
    if (!rOcam.ok) throw new Error(`écriture document OCAM Logos KO: ${rOcam.result}`);
    log(`Document OCAM « ${asciiLabel} » écrit dans dossier ${numero} (cle=${rOcam.cle})`);
  }
  return true;
}

/**
 * Bail atomique multi-poste : réserve le devis signé avant de le réécrire dans
 * Logos. Avec plusieurs postes (nombre quelconque) un seul gagne -> pas de doublon.
 * false en cas d'erreur réseau (on n'écrit pas si on n'a pas pu réserver).
 * @returns {Promise<boolean>} true si ce poste a le droit d'écrire.
 */
async function claimSigned(site, apiKey, token) {
  try {
    const res = await fetch(`${site}/api/desktop/signed-claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ token, postId: POST_ID }),
    });
    if (!res.ok) { log(`signed-claim HTTP ${res.status} (token ${String(token).slice(0, 8)})`); return false; }
    const j = await res.json().catch(() => ({}));
    return !!(j && j.claimed);
  } catch (e) {
    log(`signed-claim exception: ${e.message}`);
    return false;
  }
}

async function markArchived(site, apiKey, token) {
  try {
    const res = await fetch(`${site}/api/desktop/mark-archived`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) log(`mark-archived HTTP ${res.status} (token ${token.slice(0, 8)})`);
  } catch (e) {
    log(`mark-archived exception: ${e.message}`);
  }
}

async function tick() {
  if (_running) return;
  _running = true;
  try {
    const { site, apiKey } = siteAndKey();
    if (!apiKey) { return; } // poste pas encore appairé

    const res = await fetch(`${site}/api/desktop/signed-pending?source=logos`, {
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      log(`signed-pending HTTP ${res.status} — ${body.slice(0, 150)}`);
      return;
    }
    const json = await res.json().catch(() => ({}));
    const items = (json && json.items) || [];
    if (!items.length) { log('poll: aucun devis signé à renvoyer'); return; }
    log(`${items.length} devis signé(s) à renvoyer dans Logos`);

    // Séquentiel : évite toute contention sur ACTES_2 (l'exe ouvre/ferme le .fic).
    for (const item of items) {
      try {
        // Bail atomique multi-poste : un seul poste réécrit ce devis signé.
        if (!(await claimSigned(site, apiKey, item.token))) {
          continue; // déjà pris par un autre poste -> on passe (pas de doublon)
        }
        const done = await returnToLogos(site, item);
        if (done) await markArchived(site, apiKey, item.token);
      } catch (e) {
        log(`Devis ${String(item.token).slice(0, 8)} -> échec (retry au prochain tick): ${e.message}`);
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

// Déclenchement manuel (menu tray / test)
function runNow() { return tick(); }

module.exports = { start, stop, runNow, setLogger };
