'use strict';

/**
 * logos-store-id.js — identité UNIQUE du magasin de données Logos d'un cabinet.
 *
 * Problème : le nom du serveur (\\PANO\wlogos2) peut être identique d'un cabinet
 * à l'autre → non fiable pour dire « même cabinet ». Le nom du praticien non plus
 * (un praticien peut exercer sur deux sites).
 *
 * Solution : on pose UNE FOIS un identifiant aléatoire (GUID) dans un petit fichier
 * caché DANS le dossier patients PARTAGÉ :
 *     <Répertoire_Patients>\.mdd\store-id.txt
 * Comme ce dossier est sur le serveur et partagé, TOUS les postes du même cabinet
 * lisent le MÊME identifiant ; un autre cabinet a son propre dossier partagé donc
 * son propre identifiant — même si son serveur porte le même nom. Indépendant du
 * mapping (L:\Patients ou \\PANO\wlogos2\Patients = même fichier physique).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(m) { const s = '[STORE-ID] ' + m; if (_logger) _logger(s); else console.log(s); }

/**
 * Lit (ou crée une seule fois) l'identifiant du magasin de données.
 * @param {string} patientsDir - Répertoire_Patients (racine partagée, UNC ou lettre)
 * @returns {string|null} GUID, ou null si le dossier partagé est inaccessible.
 */
function readOrCreateStoreId(patientsDir) {
  try {
    if (!patientsDir) return null;
    const dir = path.join(String(patientsDir).trim(), '.mdd');
    const file = path.join(dir, 'store-id.txt');

    // 1) Déjà posé ? on le lit (cas de tous les postes après le premier).
    try {
      const v = fs.readFileSync(file, 'utf8').trim();
      if (v) return v;
    } catch (e) {}

    // 2) Pas encore là : on crée le dossier et on pose un identifiant. Écriture
    //    atomique ('wx' = échoue si le fichier existe déjà) pour gérer une course
    //    entre deux postes qui s'appairent en même temps.
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const id = crypto.randomUUID();
    try {
      fs.writeFileSync(file, id + '\n', { flag: 'wx' });
      log('store-id créé: ' + id);
      return id;
    } catch (e) {
      // Course perdue (un autre poste vient de le poser) -> on relit le gagnant.
      try {
        const v = fs.readFileSync(file, 'utf8').trim();
        if (v) return v;
      } catch (e2) {}
      log('store-id: écriture impossible (' + e.message + ')');
      return null;
    }
  } catch (e) {
    log('readOrCreateStoreId erreur: ' + e.message);
    return null;
  }
}

/**
 * Déduit \\serveur\partage depuis le Répertoire_Patients (pour AFFICHAGE seulement,
 * l'identité réelle = store-id). En lettre mappée, renvoie la racine telle quelle.
 */
function deriveShare(patientsDir) {
  if (!patientsDir) return null;
  const s = String(patientsDir).trim();
  const m = s.match(/^\\\\([^\\]+)\\([^\\]+)/); // \\serveur\partage\...
  if (m) return `\\\\${m[1]}\\${m[2]}`;
  return s;
}

module.exports = { setLogger, readOrCreateStoreId, deriveShare };
