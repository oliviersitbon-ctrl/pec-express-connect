"use strict";

// build-native.cjs — Precompile les types P/Invoke natifs (native/MddNative.cs)
// en une seule DLL .NET Framework 4.x : resources/native/MddNative.dll.
//
// POURQUOI : voir l'entete de native/MddNative.cs. En resume, on remplace la
// compilation C# a l'execution (Add-Type @"..."@ -> DLL temporaire a nom
// aleatoire dans %TEMP%, signalee "Adware" par G DATA) par une DLL unique,
// stable, signee et livree dans l'app. Les scripts PowerShell la chargent via
// Add-Type -Path : plus aucune compilation runtime.
//
// On compile avec le csc.exe de .NET Framework 4.x (present sur toute machine
// Windows et sur les runners GitHub windows-latest) afin que l'assembly soit
// chargeable par Windows PowerShell 5.1 (le powershell.exe utilise par le
// connecteur). NE PAS utiliser le csc de .NET (Core) : l'assembly produite ne
// serait pas chargeable par PowerShell 5.1.
//
// Lance automatiquement en CI (voir .github/workflows/release.yml) avant
// electron-builder, puis la DLL est signee LABORA. En local : `npm run
// build:native` (facultatif ; sans la DLL, les scripts retombent sur le bloc
// Add-Type inline de secours).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = path.join(__dirname, "..");
const srcCs = path.join(repoRoot, "native", "MddNative.cs");
const outDir = path.join(repoRoot, "resources", "native");
const outDll = path.join(outDir, "MddNative.dll");

function fail(msg) {
  console.error("[build-native] ERREUR: " + msg);
  process.exit(1);
}

if (process.platform !== "win32") {
  // La DLL ne peut etre compilee que sous Windows (csc .NET Framework). Sur un
  // autre OS (ex. lint local), on ne bloque pas le build : le bloc Add-Type
  // inline de secours reste fonctionnel cote Windows a l'execution.
  console.warn("[build-native] Plateforme non-Windows : compilation ignoree (fallback inline actif).");
  process.exit(0);
}

if (!fs.existsSync(srcCs)) fail("Source introuvable : " + srcCs);

// Localiser csc.exe (.NET Framework 4.x). Framework64 en priorite (64 bits).
const winDir = process.env.WINDIR || process.env.SystemRoot || "C:\\Windows";
const cscCandidates = [
  path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
  path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
];
const csc = cscCandidates.find((c) => fs.existsSync(c));
if (!csc) fail("csc.exe (.NET Framework 4.x) introuvable dans:\n  " + cscCandidates.join("\n  "));

fs.mkdirSync(outDir, { recursive: true });

console.log("[build-native] csc    : " + csc);
console.log("[build-native] source : " + srcCs);
console.log("[build-native] sortie : " + outDll);

try {
  execFileSync(
    csc,
    ["/nologo", "/target:library", "/optimize+", "/out:" + outDll, srcCs],
    { stdio: "inherit" }
  );
} catch (e) {
  fail("Echec de la compilation csc : " + (e && e.message ? e.message : e));
}

if (!fs.existsSync(outDll)) fail("La DLL n'a pas ete produite : " + outDll);
const size = fs.statSync(outDll).size;
console.log("[build-native] OK — MddNative.dll (" + size + " octets)");
