"use strict";

// Hook de signature electron-builder -> Azure Trusted Signing (LABORA).
// electron-builder appelle cette fonction une fois PAR fichier a signer
// (app .exe, desinstalleur, installeur NSIS, exes natifs...). On utilise
// l'outil officiel Microsoft "sign" (dotnet global tool). execFileSync est
// SYNCHRONE => les signatures sont serialisees, ce qui evite la condition de
// course de la signature Azure integree d'electron-builder (bug #9076).
//
// Authentification : l'outil "sign" utilise Azure DefaultAzureCredential, qui
// lit AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET depuis
// l'environnement (fournis par le workflow GitHub Actions).

const { execFileSync } = require("child_process");
const path = require("path");

exports.default = function sign(configuration) {
  const file = configuration.path;

  // Chemin absolu de l'outil "sign" installe en global (evite les soucis de PATH
  // dans le sous-processus electron-builder).
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const signExe = path.join(home, ".dotnet", "tools", "sign.exe");

  execFileSync(
    signExe,
    [
      "code",
      "trusted-signing",
      "-b",
      path.dirname(file),
      path.basename(file),
      "-tse",
      "https://neu.codesigning.azure.net/",
      "-tsa",
      "labora-signing",
      "-tscp",
      "labora-public",
      "-v",
      "Information",
    ],
    { stdio: "inherit" }
  );
};
