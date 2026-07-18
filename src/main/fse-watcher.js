'use strict';

/**
 * fse-watcher.js — voie Logos du module Trust.
 *
 * Surveille le(s) dossier(s) SESAM des FSE. Dès qu'une NOUVELLE feuille de soins
 * apparaît avec au moins un acte daté du JOUR MÊME, on :
 *   1) lit le NIR + le NUMÉRO AM (praticien) dans la FSE (fse-parser),
 *   2) matche le numéro AM à un praticien MDD (/api/desktop/fse-practitioner-resolve).
 *      Non mappé → ÉCHEC SILENCIEUX. Mappé → on récupère le nom du praticien.
 *   3) retrouve les coordonnées patient dans CIVIL.FIC par NIR (logos-civil-reader),
 *   4) POST { patient, practitionerName, source:'logosw' } vers submit-patient.
 *      Le SERVEUR applique tous les filtres (trigger, cooldown, max/RDV…).
 *
 * IMPORTANT — layout Logos : les FSE sont rangées PAR PRATICIEN dans un
 * sous-dossier code praticien, ex. \\PANO\wlogos2\OS\SESAM\FSE. On scanne donc
 * <racine>\SESAM\FSE ET <racine>\<code>\SESAM\FSE (gère aussi le multi-praticien).
 *
 * Au démarrage on prend un instantané des FSE déjà présentes et on ne traite QUE
 * les nouvelles — sinon on re-solliciterait tout l'historique.
 */

const fs = require('fs');
const path = require('path');
const fseParser = require('./fse-parser');
const civil = require('./logos-civil-reader');
const logosIni = require('./logos-ini');

let _logger = null;
let _iniPatientsDir = null; // Répertoire_Patients lu dans LOGOS_w.INI (repli portable)
function setLogger(fn) { _logger = fn; fseParser.setLogger(fn); civil.setLogger(fn); logosIni.setLogger(fn); }
function log(m) { const s = `[FSE-WATCH] ${m}`; if (_logger) _logger(s); else console.log(s); }

// Projet Supabase (edge functions). La clé anon est publique (comme dans tout
// client web) ; l'authentification cabinet se fait par x-api-key côté fonction.
const SUPA_FUNCTIONS_DEFAULT = 'https://zyohujwxsagjqnhddimk.supabase.co/functions/v1';
const SUPA_ANON_DEFAULT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp5b2h1and4c2FnanFuaGRkaW1rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk3OTc1MTgsImV4cCI6MjA5NTM3MzUxOH0.AC5A-r2rxUiY9X9M31dHB-qnC7VH7DOFD5v3220ixd8';

const POLL_MS = 4000;

let _timer = null;
let _watchers = [];
let _seen = new Set();       // clés "dir|name" (idempotence)
let _fseDirs = [];           // dossiers FSE surveillés
let _getCtx = () => ({});

function todayIso() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function listFse(dir) {
  try { return fs.readdirSync(dir).filter((f) => /\.fse$/i.test(f)); } catch (e) { return []; }
}

/**
 * Résout TOUS les dossiers FSE. Logos range les FSE par praticien :
 * <racine>\<CODE_PRATICIEN>\SESAM\FSE (ex. \\PANO\wlogos2\OS\SESAM\FSE), et
 * parfois directement <racine>\SESAM\FSE. On scanne donc aussi les sous-dossiers.
 */
function resolveFseDirs(ctx) {
  const found = new Set();
  const add = (p) => { try { if (p && fs.existsSync(p)) found.add(p); } catch (e) {} };
  if (ctx.fseDir) add(ctx.fseDir);

  // 1) VOIE PORTABLE — via LOGOS_w.INI : Répertoire_Patients + GPID_Prats donnent
  //    les dossiers FSE exacts <racine>\<code>\SESAM\FSE, sans rien deviner et
  //    sans dépendre d'un devis préalable. Adapté à n'importe quel cabinet.
  try {
    const ini = logosIni.resolveFseDirsFromIni(ctx.logosIniPath);
    if (ini.patientsDir) _iniPatientsDir = ini.patientsDir;
    for (const d of ini.dirs) add(d);
  } catch (e) {}

  // 2) REPLI — dérivation depuis le patientsDir connu (config ou INI) + scan des
  //    sous-dossiers, au cas où l'INI serait introuvable ou le layout inhabituel.
  const pd = ctx.patientsDir || _iniPatientsDir;
  if (pd) {
    const roots = [pd, path.dirname(pd), path.dirname(path.dirname(pd))];
    for (const r of roots) {
      add(path.join(r, 'SESAM', 'FSE')); // <racine>\SESAM\FSE
      // <racine>\<code>\SESAM\FSE : un dossier par praticien
      let subs = [];
      try {
        subs = fs.readdirSync(r, { withFileTypes: true })
          .filter((d) => d.isDirectory()).map((d) => d.name);
      } catch (e) {}
      for (const s of subs) add(path.join(r, s, 'SESAM', 'FSE'));
    }
  }
  return [...found];
}

async function isStable(fp) {
  try {
    const s1 = fs.statSync(fp).size; if (!s1) return false;
    await new Promise((r) => setTimeout(r, 600));
    const s2 = fs.statSync(fp).size;
    return s2 > 0 && s1 === s2;
  } catch (e) { return false; }
}

async function postTrust(patient, practitionerName) {
  const fetch = require('node-fetch');
  const ctx = _getCtx() || {};
  const url = (ctx.functionsUrl || SUPA_FUNCTIONS_DEFAULT) + '/submit-patient';
  const anon = ctx.anonKey || SUPA_ANON_DEFAULT;
  const payload = { source: 'logosw', patient };
  if (practitionerName) payload.practitionerName = practitionerName;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + anon,
      'apikey': anon,
      'x-api-key': ctx.apiKey || '',
    },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body: j };
}

/**
 * Matching praticien par NUMÉRO AM (seul identifiant praticien porté par la FSE).
 * Renvoie { blocked, practitionerName }. blocked=true -> ÉCHEC SILENCIEUX.
 * S'appuie sur /api/desktop/fse-practitioner-resolve (unifié avec Praticiens Logos).
 */
async function resolvePractitioner(numeroAm) {
  const fetch = require('node-fetch');
  const ctx = _getCtx() || {};
  const site = ctx.siteUrl || 'https://app.mondevisdentaire.com';
  const apiKey = ctx.apiKey || '';
  try {
    const res = await fetch(`${site}/api/desktop/fse-practitioner-resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ numeroAm: numeroAm || '' }),
    });
    const j = await res.json().catch(() => ({}));
    return { blocked: !!(j && j.blocked), practitionerName: (j && j.practitionerName) || null };
  } catch (e) {
    log('résolution praticien (numéro AM) échec réseau -> skip silencieux: ' + e.message);
    return { blocked: true, practitionerName: null }; // fail-closed : pas d'envoi à tort
  }
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

  // Matching praticien par numéro AM (échec silencieux si non mappé à un
  // praticien MDD). Le numéro AM est journalisé côté serveur pour le mapping.
  const reso = await resolvePractitioner(parsed.numeroAM);
  if (reso.blocked) {
    log(`${name} : praticien (n° AM ${parsed.numeroAM || '?'}) non mappé -> skip silencieux`);
    return;
  }

  const ctx = _getCtx() || {};
  const patientsDir = ctx.patientsDir || _iniPatientsDir; // INI en repli si pas encore de devis
  const rec = civil.readPatientByNir(patientsDir, parsed.nir);
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
    const r = await postTrust(patient, reso.practitionerName);
    if (r.ok && r.body && r.body.skipped) log(`${name} : Trust ignoré par le serveur (${r.body.reason || 'filtre'})`);
    else if (r.ok) log(`${name} : Trust déclenché pour ${rec.nom} ${rec.prenom}`);
    else log(`${name} : POST Trust échec HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 140)}`);
  } catch (e) {
    log(`${name} : POST Trust exception ${e.message}`);
  }
}

function onNew(dir, name) {
  const key = dir + '|' + name;
  if (_seen.has(key)) return;
  _seen.add(key);
  const fp = path.join(dir, name);
  log('nouvelle FSE détectée: ' + fp);
  processFile(fp, name);
}

function ensureWatching() {
  const ctx = _getCtx() || {};
  const dirs = resolveFseDirs(ctx);
  for (const dir of dirs) {
    if (_fseDirs.includes(dir)) continue; // déjà surveillé
    _fseDirs.push(dir);
    const existing = listFse(dir);
    for (const f of existing) _seen.add(dir + '|' + f); // snapshot : ignorer l'existant
    log(`surveillance FSE : ${dir} (${existing.length} existantes ignorées ; nouvelles surveillées)`);
    try {
      const w = fs.watch(dir, (ev, fn) => { if (fn && /\.fse$/i.test(fn)) onNew(dir, fn); });
      _watchers.push(w);
    } catch (e) { log('fs.watch indisponible sur ' + dir + ' (' + e.message + ') — polling seul'); }
  }
}

/**
 * Démarre le watcher.
 * @param {Function} getCtx - renvoie { patientsDir, apiKey, siteUrl?, fseDir?, functionsUrl?, anonKey? }
 */
function start(getCtx) {
  if (typeof getCtx === 'function') _getCtx = getCtx;
  if (_timer) return;
  ensureWatching();
  _timer = setInterval(() => {
    ensureWatching(); // découvre aussi de nouveaux dossiers praticien
    for (const dir of _fseDirs) { for (const f of listFse(dir)) onNew(dir, f); }
  }, POLL_MS);
  log('watcher FSE actif (poll ' + POLL_MS + 'ms)');
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
  for (const w of _watchers) { try { w.close(); } catch (e) {} }
  _watchers = [];
}

module.exports = { setLogger, start, stop };
