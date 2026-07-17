'use strict';

/**
 * fse-watcher.js — voie Logos du module Trust.
 *
 * Surveille le dossier SESAM des FSE. Dès qu'une NOUVELLE feuille de soins
 * apparaît avec au moins un acte daté du JOUR MÊME, on :
 *   1) lit le NIR dans la FSE (fse-parser),
 *   2) retrouve les coordonnées patient dans CIVIL.FIC par NIR (logos-civil-reader),
 *   3) POST { patient, source:'logosw' } vers l'edge function submit-patient
 *      (clé API du cabinet). Le SERVEUR applique tous les filtres (cooldown,
 *      max/RDV, trigger configuré…) et envoie la demande d'avis si autorisé.
 *
 * IMPORTANT : au démarrage on prend un instantané des FSE déjà présentes et on
 * ne traite QUE les nouvelles — sinon on re-solliciterait tout l'historique.
 */

const fs = require('fs');
const path = require('path');
const fseParser = require('./fse-parser');
const civil = require('./logos-civil-reader');

let _logger = null;
function setLogger(fn) { _logger = fn; fseParser.setLogger(fn); civil.setLogger(fn); }
function log(m) { const s = `[FSE-WATCH] ${m}`; if (_logger) _logger(s); else console.log(s); }

// Projet Supabase (edge functions). La clé anon est publique (comme dans tout
// client web) ; l'authentification cabinet se fait par x-api-key côté fonction.
const SUPA_FUNCTIONS_DEFAULT = 'https://zyohujwxsagjqnhddimk.supabase.co/functions/v1';
const SUPA_ANON_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5b2h1and4c2FnanFuaGRkaW1rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3OTc1MTgsImV4cCI6MjA5NTM3MzUxOH0.AC5A-r2rxUiY9X9M31dHB-qnC7VH7DOFD5v3220ixd8';

const POLL_MS = 4000;

let _timer = null;
let _watcher = null;
let _seen = new Set();
let _fseDir = null;
let _getCtx = () => ({});

function todayIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function listFse(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.fse$/i.test(f)); } catch (e) { return []; }
}

/** Résout le dossier FSE : config explicite, sinon détection près du dossier patients. */
function resolveFseDir(ctx) {
  if (ctx.fseDir && fs.existsSync(ctx.fseDir)) return ctx.fseDir;
  const pd = ctx.patientsDir;
  if (pd) {
    const roots = [pd, path.dirname(pd), path.dirname(path.dirname(pd))];
    for (const r of roots) {
      const cand = path.join(r, 'SESAM', 'FSE');
      try { if (fs.existsSync(cand)) return cand; } catch (e) {}
    }
  }
  return null;
}

async function isStable(fp) {
  try {
    const s1 = fs.statSync(fp).size; if (!s1) return false;
    await new Promise((r) => setTimeout(r, 600));
    const s2 = fs.statSync(fp).size;
    return s2 > 0 && s1 === s2;
  } catch (e) { return false; }
}

async function postTrust(patient) {
  const fetch = require('node-fetch');
  const ctx = _getCtx() || {};
  const url = (ctx.functionsUrl || SUPA_FUNCTIONS_DEFAULT) + '/submit-patient';
  const anon = ctx.anonKey || SUPA_ANON_DEFAULT;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + anon,
      'apikey': anon,
      'x-api-key': ctx.apiKey || '',
    },
    body: JSON.stringify({ source: 'logosw', patient }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
}

async function processFile(fp, name, tries = 0) {
  if (!(await isStable(fp))) {
    if (tries < 6) { setTimeout(() => processFile(fp, name, tries + 1), 1500); }
    else log(`${name} : fichier jamais stabilisé -> abandon`);
    return;
  }
  const parsed = fseParser.parseFse(fp);
  if (!parsed || !parsed.nir) { log('parse impossible: ' + name); return; }

  const today = todayIso();
  if (!fseParser.hasActeOnDate(parsed, today)) {
    log(`${name} : aucun acte du jour (actes=${parsed.acteDates.join(',') || '—'}) -> ignoré`);
    return;
  }

  const ctx = _getCtx() || {};
  const rec = civil.readPatientByNir(ctx.patientsDir, parsed.nir);
  if (!rec) { log(`${name} : patient (NIR) introuvable dans CIVIL.FIC -> abandon`); return; }
  if (!rec.email && !rec.portable) { log(`${name} : ni email ni téléphone -> abandon`); return; }

  const patient = {
    email: rec.email || null,
    firstName: rec.prenom || null,
    lastName: rec.nom || null,
    phone: rec.portable || null,
    civility: rec.civilite || null,
  };
  try {
    const r = await postTrust(patient);
    if (r.ok && r.body && r.body.skipped) log(`${name} : Trust ignoré par le serveur (${r.body.reason || 'filtre'})`);
    else if (r.ok) log(`${name} : Trust déclenché pour ${rec.nom} ${rec.prenom}`);
    else log(`${name} : POST Trust échec HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  } catch (e) {
    log(`${name} : POST Trust exception ${e.message}`);
  }
}

function onNew(name) {
  if (!_fseDir || _seen.has(name)) return;
  _seen.add(name);
  const fp = path.join(_fseDir, name);
  log('nouvelle FSE détectée: ' + name);
  processFile(fp, name);
}

function ensureWatching() {
  if (_fseDir) return; // déjà résolu
  const ctx = _getCtx() || {};
  const dir = resolveFseDir(ctx);
  if (!dir) return; // pas encore résoluble (patientsDir inconnu…) : on réessaiera
  _fseDir = dir;
  _seen = new Set(listFse(dir)); // snapshot : on n'envoie rien pour l'existant
  log(`démarré sur ${dir} (${_seen.size} FSE existantes ignorées ; surveillance des nouvelles)`);
  try {
    _watcher = fs.watch(dir, (ev, fn) => { if (fn && /\.fse$/i.test(fn)) onNew(fn); });
  } catch (e) { log('fs.watch indisponible (' + e.message + ') — polling seul'); }
}

/**
 * Démarre le watcher.
 * @param {Function} getCtx - renvoie { patientsDir, apiKey, fseDir?, functionsUrl?, anonKey? }
 */
function start(getCtx) {
  if (typeof getCtx === 'function') _getCtx = getCtx;
  if (_timer) return;
  ensureWatching();
  _timer = setInterval(() => {
    ensureWatching();
    if (_fseDir) { for (const f of listFse(_fseDir)) onNew(f); }
  }, POLL_MS);
  log('watcher FSE actif (poll ' + POLL_MS + 'ms)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  if (_watcher) { try { _watcher.close(); } catch (e) {} _watcher = null; }
}

module.exports = { setLogger, start, stop };
