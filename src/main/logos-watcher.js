/**
 * logos-watcher.js — DÉSACTIVÉ.
 *
 * L'ancien mécanisme d'injection d'une DLL dans LOGOS_w.exe (via WMI +
 * injecteur natif) a été SUPPRIMÉ. La détection de Logos et le déclenchement
 * des actions passent désormais uniquement par les boutons flottants
 * (overlay Win32 — voir overlay-pec.js / overlay-fiche.js).
 *
 * Ce module ne fait plus rien. Il est conservé (vide) uniquement pour ne pas
 * casser un éventuel require résiduel ; il n'est plus référencé par index.js.
 */
function noop() {}
module.exports = { setLogger: noop, startWatcher: noop, stopWatcher: noop };
