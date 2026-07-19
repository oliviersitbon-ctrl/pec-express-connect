'use strict';

/**
 * poste-gate.js — verrou d'activité du poste (garde-fou d'appairage multi-poste).
 *
 * EN MÉMOIRE (jamais persisté sur disque) : quand le serveur classe CE poste
 * « pending » (magasin de données différent des autres postes du cabinet) ou
 * « blocked » (refusé en superadmin), on met le poste EN VEILLE :
 *   - aucun envoi de devis / PEC / questionnaire,
 *   - aucune écriture de document dans Logos (retours signés, lignes, questionnaire),
 *   - aucun déclenchement Trust (FSE),
 * jusqu'à validation par l'administrateur (superadmin → Postes Logos → Approuver).
 *
 * Défaut : NON bloqué (fail-open). Le serveur bascule le verrou dès le premier
 * enregistrement du poste (registerPoste), qui tourne au démarrage, après
 * l'appairage, et toutes les 15 min. Un poste refusé/en attente est donc mis en
 * veille en quelques secondes, et réactivé dans les 15 min suivant son approbation.
 */

let _blocked = false;
let _status = null;
let _logger = null;

function setLogger(fn) { _logger = fn; }
function log(m) { const s = '[POSTE-GATE] ' + m; if (_logger) _logger(s); else console.log(s); }

/** Met à jour le statut serveur du poste et (dés)active le verrou. */
function setStatus(status) {
  const b = status === 'pending' || status === 'blocked';
  if (b !== _blocked) {
    log(b
      ? 'poste MIS EN VEILLE (statut ' + status + ') — en attente de validation administrateur'
      : 'poste ACTIF (approuvé)');
  }
  _status = status || null;
  _blocked = b;
}

/** true = le poste est en veille (ne doit rien envoyer ni écrire). */
function isBlocked() { return _blocked; }
function status() { return _status; }

module.exports = { setLogger, setStatus, isBlocked, status };
