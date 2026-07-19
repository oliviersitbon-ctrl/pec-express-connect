"use strict";

// native-dll.js — Resolution + chargement de MddNative.dll (types P/Invoke
// precompiles). Voir native/MddNative.cs et scripts/build-native.cjs.
//
// But : eviter la compilation C# a l'execution (Add-Type @"..."@), qui produit
// une DLL temporaire a nom aleatoire dans %TEMP% signalee par certains antivirus
// (G DATA => Gen:Variant.Adware). On charge a la place une DLL unique, stable et
// signee, via Add-Type -Path.

const path = require("path");
const fs = require("fs");

// Chemin absolu de MddNative.dll, ou null si introuvable.
// - App packagee : <resources>/resources/native/MddNative.dll
//   (extraResources package.json : "resources/native" -> "resources/native")
// - Dev (electron .) : <repo>/resources/native/MddNative.dll
function nativeDllPath() {
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "resources", "native", "MddNative.dll"));
  }
  // Dev : ce fichier est dans src/main -> remonter de 2 niveaux vers la racine.
  candidates.push(path.join(__dirname, "..", "..", "resources", "native", "MddNative.dll"));
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return null;
}

// Renvoie un extrait PowerShell qui, si MddNative.dll existe et que le type
// `typeName` n'est pas deja charge, charge la DLL via Add-Type -Path.
//
// A INSERER dans le script PS juste AVANT le bloc `if (-not ('X' -as [type])) {
// Add-Type @"..."@ }` de secours. Si la DLL est absente (dev sans compilation),
// cet extrait est vide et le bloc Add-Type inline prend le relais : zero
// regression. Si la DLL est presente, elle est chargee et le bloc inline (garde
// par le meme test de type) n'est jamais atteint : aucune compilation runtime,
// donc aucune DLL temporaire.
function psLoadNative(typeName) {
  const dll = nativeDllPath();
  if (!dll) return "";
  const esc = String(dll).replace(/'/g, "''"); // echappe la quote simple PowerShell
  return (
    "\n$__mddDll = '" + esc + "'\n" +
    "if ((Test-Path -LiteralPath $__mddDll) -and -not ('" + typeName + "' -as [type])) {\n" +
    "  try { Add-Type -Path $__mddDll -ErrorAction Stop } catch { }\n" +
    "}\n"
  );
}

module.exports = { nativeDllPath, psLoadNative };
