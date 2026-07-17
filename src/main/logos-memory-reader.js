/**
 * Logos Memory Reader
 *
 * Lit la memoire du process LOGOS_w.exe pour extraire le devis affiche
 * meme s'il n'est pas encore sauvegarde dans la BDD.
 *
 * Pattern d'ancrage decouvert par reverse engineering: la chaine "honorairesG="
 * apparait uniquement dans le XML d'un devis vivant en RAM. Format complet:
 *
 *   honorairesG="5583.5" baseG="1002.75" amoG="601.65" resteG="4981.85"
 *   ... nomPatient="MACAS SERRANO" prenomPatient="Paola Lorena" ...
 *   <Ligne code="CCAMIN" dent="17" nom="Inlay/onlay composite" cotation="HBMD351"
 *     honoraires="360.5" base="100" amo="60" reste="300.5" />
 *   <Ligne dent="Bas" nom="Prothese..." cotation="HBLD031"
 *     honoraires="1133" base="182.75" amo="109.65" reste="1023.35" />
 *   ...
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[LOGOS-MEM] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

// Trouve le chemin du script PS de lecture memoire
function findReaderScript() {
  const candidates = [
    path.join(process.resourcesPath || '', 'resources', 'win', 'read-logos-devis.ps1'),
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', 'read-logos-devis.ps1'),
    path.join(path.dirname(process.execPath), 'resources', 'win', 'read-logos-devis.ps1'),
    path.join(__dirname, '..', '..', 'resources', 'win', 'read-logos-devis.ps1'),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

// Trouve le chemin d'un script PS dans resources/win (generique)
function findWinScript(name) {
  const candidates = [
    path.join(process.resourcesPath || '', 'resources', 'win', name),
    path.join(path.dirname(process.execPath), 'resources', 'resources', 'win', name),
    path.join(path.dirname(process.execPath), 'resources', 'win', name),
    path.join(__dirname, '..', '..', 'resources', 'win', name),
  ];
  for (const p of candidates) {
    try { if (p && fs.existsSync(p)) return p; } catch (e) {}
  }
  return null;
}

/**
 * Lit l'email du patient depuis la RAM de LOGOS_w (fiche patient / Etat civil).
 * Ancre sur le nom de famille. Renvoie l'email (string) ou null.
 *
 * @param {Object} opts
 * @param {string} opts.nom - nom de famille du patient (ancre, requis)
 * @param {string} [opts.nir] - NIR pour renforcer l'ancrage (optionnel)
 * @param {string} [opts.excludeDomain] - domaine a exclure (ex. celui du cabinet)
 * @returns {Promise<string|null>}
 */
async function readPatientEmail(opts = {}) {
  const nom = (opts.nom || '').trim();
  if (!nom) { log('readPatientEmail: nom manquant'); return null; }
  const scriptPath = findWinScript('read-logos-email.ps1');
  if (!scriptPath) { log('read-logos-email.ps1 introuvable'); return null; }

  const outPath = path.join(os.tmpdir(), `logos-email-${Date.now()}.txt`);
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Nom', nom,
    '-OutputFile', outPath,
  ];
  if (opts.nir) args.push('-Nir', String(opts.nir));
  if (opts.excludeDomain) args.push('-ExcludeDomain', String(opts.excludeDomain));

  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; try { fs.existsSync(outPath) && fs.unlinkSync(outPath); } catch (e) {} resolve(val); } };
    let proc;
    try {
      proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { log('readPatientEmail spawn error: ' + e.message); return finish(null); }
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.on('error', (e) => { log('readPatientEmail error: ' + e.message); finish(null); });
    proc.on('close', () => {
      let email = null;
      try { if (fs.existsSync(outPath)) email = fs.readFileSync(outPath, 'utf8').trim(); } catch (e) {}
      if (!email && stdout) {
        const m = stdout.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/);
        if (m) email = m[0].trim();
      }
      email = email && email.includes('@') ? email.toLowerCase() : null;
      log('readPatientEmail("' + nom + '") -> ' + (email || 'aucun'));
      finish(email);
    });
    // Filet de securite: 8s max
    setTimeout(() => { try { proc && proc.kill(); } catch (e) {} finish(null); }, 8000);
  });
}

/**
 * Lit l'IDENTITE du patient (date de naissance + email) depuis la RAM de
 * LOGOS_w lorsque la FICHE PATIENT (Etat civil) est ouverte. Ancre sur le nom
 * de famille (comme readPatientEmail). Sert au bouton "Questionnaire MD".
 *
 * @param {Object} opts
 * @param {string} opts.nom - nom de famille (ancre, requis)
 * @param {string} [opts.excludeDomain] - domaine email a exclure (cabinet)
 * @returns {Promise<{dob:string|null, nir:string|null, email:string|null}|null>}
 *          dob au format DD/MM/YYYY.
 */
async function readPatientIdentity(opts = {}) {
  const nom = (opts.nom || '').trim();
  if (!nom) { log('readPatientIdentity: nom manquant'); return null; }
  const scriptPath = findWinScript('read-logos-patient.ps1');
  if (!scriptPath) { log('read-logos-patient.ps1 introuvable'); return null; }

  const outPath = path.join(os.tmpdir(), `logos-patient-${Date.now()}.json`);
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-Nom', nom,
    '-OutputFile', outPath,
  ];
  if (opts.excludeDomain) args.push('-ExcludeDomain', String(opts.excludeDomain));

  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      try { fs.existsSync(outPath) && fs.unlinkSync(outPath); } catch (e) {}
      resolve(val);
    };
    let proc;
    try {
      proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { log('readPatientIdentity spawn error: ' + e.message); return finish(null); }
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    proc.on('error', (e) => { log('readPatientIdentity error: ' + e.message); finish(null); });
    proc.on('close', () => {
      let json = null;
      try {
        let raw = '';
        if (fs.existsSync(outPath)) raw = fs.readFileSync(outPath, 'utf8').trim();
        if (!raw && stdout) {
          const m = stdout.match(/\{[^}]*\}/);
          if (m) raw = m[0];
        }
        if (raw) json = JSON.parse(raw);
      } catch (e) { log('readPatientIdentity parse error: ' + e.message); }
      const out = json ? { dob: json.dob || null, nir: json.nir || null, email: json.email || null } : null;
      log('readPatientIdentity("' + nom + '") -> dob=' + (out && out.dob ? out.dob : 'null'));
      finish(out);
    });
    setTimeout(() => { try { proc && proc.kill(); } catch (e) {} finish(null); }, 9000);
  });
}

// Script PS qui ouvre LOGOS_w.exe, cherche "honorairesG=" et dump le XML
// autour (8000 bytes avant + 16000 apres pour avoir le devis complet).
const PS_READER_INLINE = String.raw`
param([string]$OutputFile)

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;

public class LMR {
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern IntPtr OpenProcess(int a, bool i, int p);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern int VirtualQueryEx(IntPtr h, IntPtr a, out MBI b, int s);
    [DllImport("kernel32.dll", SetLastError=true)]
    public static extern bool ReadProcessMemory(IntPtr h, IntPtr a, [Out] byte[] b, int s, out int r);

    [StructLayout(LayoutKind.Sequential)] public struct MBI {
        public IntPtr BaseAddress; public IntPtr AllocationBase; public uint AllocationProtect;
        public IntPtr RegionSize; public uint State; public uint Protect; public uint Type;
    }

    public static byte[] FindAndDump(int pid, byte[] pattern, int beforeBytes, int afterBytes) {
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) return null;

        long addr = 0;
        long maxAddr = 4294967295L;
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        MBI mbi;
        byte p0 = pattern[0];
        int patLen = pattern.Length;
        byte[] bestDump = null;
        int bestActes = -1;

        while (addr < maxAddr) {
            int qret = VirtualQueryEx(h, new IntPtr(addr), out mbi, mbiSize);
            if (qret == 0) break;
            long rs = mbi.RegionSize.ToInt64();
            long ba = mbi.BaseAddress.ToInt64();
            uint pr = mbi.Protect;
            bool readable = (mbi.State == 0x1000) && (pr == 0x04 || pr == 0x02 || pr == 0x20 || pr == 0x40);
            if (readable && rs > 0 && rs < 100 * 1024 * 1024L) {
                byte[] buf = new byte[rs];
                int br;
                if (ReadProcessMemory(h, mbi.BaseAddress, buf, (int)rs, out br) && br > 0) {
                    int limit = br - patLen;
                    for (int i = 0; i <= limit; i++) {
                        if (buf[i] != p0) continue;
                        bool m = true;
                        for (int j = 1; j < patLen; j++) {
                            if (buf[i+j] != pattern[j]) { m = false; break; }
                        }
                        if (m) {
                            int cs = Math.Max(0, i - beforeBytes);
                            int ce = Math.Min(br, i + patLen + afterBytes);
                            byte[] dump = new byte[ce - cs];
                            Array.Copy(buf, cs, dump, 0, dump.Length);
                            // Compter le nb de "<Ligne" dans ce dump pour selectionner
                            // le meilleur (= celui avec le plus d'actes)
                            int countActes = 0;
                            byte[] needle = Encoding.GetEncoding("iso-8859-1").GetBytes("<Ligne");
                            for (int k = 0; k <= dump.Length - needle.Length; k++) {
                                bool nm = true;
                                for (int l = 0; l < needle.Length; l++) {
                                    if (dump[k+l] != needle[l]) { nm = false; break; }
                                }
                                if (nm) countActes++;
                            }
                            if (countActes > bestActes) {
                                bestActes = countActes;
                                bestDump = dump;
                            }
                        }
                    }
                }
            }
            long newAddr = ba + rs;
            if (newAddr <= addr) break;
            addr = newAddr;
        }
        CloseHandle(h);
        return bestDump;
    }
}
"@ -ErrorAction SilentlyContinue

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Error "Logos not running"; exit 1 }

$pat = [System.Text.Encoding]::GetEncoding("iso-8859-1").GetBytes('honorairesG=')
$dump = [LMR]::FindAndDump($proc.Id, $pat, 8000, 16000)
if (-not $dump) { Write-Error "No devis found in memory"; exit 2 }

# Sauve le dump brut (Latin-1) dans le fichier de sortie pour parsing cote Node
[System.IO.File]::WriteAllBytes($OutputFile, $dump)
Write-Output "OK $($dump.Length)"
`;

let _readerBusy = false;

/**
 * Lit le devis affiche dans Logos depuis la RAM.
 *
 * @param {object} opts
 * @param {string} opts.patientFilter - filtre nomPatient="<XXX>" pour ne pas
 *                                      lire un vieux devis en cache
 * @returns {Promise<{success: boolean, patient?: {nom,prenom}, totals?: {...},
 *                    actes?: Array, error?: string}>}
 */
async function readCurrentDevis(opts = {}) {
  if (_readerBusy) return { success: false, error: 'busy' };
  _readerBusy = true;

  const dumpPath = path.join(os.tmpdir(), `logos-devis-${Date.now()}-${process.pid}.bin`);

  try {
    const scriptPath = findReaderScript();
    if (!scriptPath) {
      _readerBusy = false;
      return { success: false, error: 'reader-script-not-found' };
    }

    const args = [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-OutputFile', dumpPath
    ];
    if (opts.patientFilter) {
      args.push('-PatientFilter', opts.patientFilter);
    }

    // Lance PS pour extraire le dump
    const psOk = await new Promise((resolve) => {
      const proc = spawn('powershell.exe', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
      const timeout = setTimeout(() => { try { proc.kill(); } catch (e) {} resolve(false); }, 10000);
      proc.on('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          log(`PS reader exit ${code}: ${stderr.slice(0, 200)}`);
          resolve(false);
        } else {
          resolve(true);
        }
      });
      proc.on('error', () => { clearTimeout(timeout); resolve(false); });
    });

    if (!psOk || !fs.existsSync(dumpPath)) {
      _readerBusy = false;
      return { success: false, error: 'no-dump' };
    }

    // Lire le dump brut. Logos stocke les strings en UTF-8 dans le XML
    // (decouverte: les caracteres accentues apparaissent en bytes UTF-8 valides).
    const raw = fs.readFileSync(dumpPath);
    const text = raw.toString('utf8');
    try { fs.unlinkSync(dumpPath); } catch (e) {}

    // Parser le texte
    const result = parseDevisXml(text);
    _readerBusy = false;
    return result;
  } catch (e) {
    _readerBusy = false;
    try { fs.unlinkSync(dumpPath); } catch (er) {}
    return { success: false, error: e.message };
  }
}

/**
 * Parse le dump memoire (~24KB Latin-1) pour extraire patient + actes.
 */
function parseDevisXml(text) {
  // Patient (header XML)
  const patientMatch = text.match(/nomPatient="([^"]+)"\s+prenomPatient="([^"]+)"/);
  const totalsMatch = text.match(/honorairesG="([\d.]+)"\s+baseG="([\d.]+)"\s+amoG="([\d.]+)"\s+resteG="([\d.]+)"/);
  const ageMatch = text.match(/agePatient="(\d+)"/);
  const sexeMatch = text.match(/sexePatient="([MF])"/);
  const creationMatch = text.match(/creation="(\d{8})"/);
  const praticienMatch = text.match(/praticien="([^"]+)"/);
  // NIR + date naissance: dans une zone proche (nirBeneficiaire="..." ou format Vitale)
  const nirMatch = text.match(/nirBeneficiaire="([\d\s]+)"/) ||
                   text.match(/\b([12]\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{3}\s?\d{3}(?:\s?\d{2})?)\b/);
  const dobMatch = text.match(/dateNaissance(?:Patient)?="(\d{8})"/) ||
                   text.match(/dateNaiss(?:ance)?="(\d{8})"/) ||
                   text.match(/datenaiss="(\d{8})"/i);

  // Actes: <Ligne ... />
  // Logos garde souvent 2 copies (forme courte + miroir) - on dedup par
  // (cotation, dent) en gardant la 1ere occurrence COMPLETE.
  const acteRe = /<Ligne\s+([^>]*?)\/?>/g;
  const acteMap = new Map();
  let m;
  while ((m = acteRe.exec(text)) !== null) {
    const attrs = m[1];
    const get = (name) => {
      const r = new RegExp(name + '="([^"]*)"');
      const a = attrs.match(r);
      return a ? a[1] : '';
    };
    const acte = {
      code_interne: get('code'),
      code_ccam: get('cotation'),
      nature_acte: get('nom'),
      numero_dent: get('dent'),
      montant: get('honoraires'),
      base_remboursement: get('base'),
      taux: get('tx'),
      amo: get('amo'),
      reste_charge: get('reste'),
      materiaux: get('mats'),
      niveau: get('niveau'),
      accord: get('accord')
    };
    if (!acte.code_ccam && !acte.nature_acte) continue;

    const key = `${acte.code_ccam}|${acte.numero_dent}|${acte.montant}`;
    // Garder la version la plus complete (avec le plus d'attributs non vides)
    const score = Object.values(acte).filter(v => v && String(v).length > 0).length;
    const existing = acteMap.get(key);
    if (!existing || score > existing._score) {
      acte._score = score;
      acteMap.set(key, acte);
    }
  }
  const actes = Array.from(acteMap.values()).map(a => { delete a._score; return a; });

  if (!patientMatch && actes.length === 0) {
    return { success: false, error: 'no-patient-no-actes' };
  }

  return {
    success: true,
    patient: patientMatch ? {
      nom: patientMatch[1].trim(),
      prenom: patientMatch[2].trim(),
      age: ageMatch ? parseInt(ageMatch[1], 10) : null,
      sexe: sexeMatch ? sexeMatch[1] : null,
      nir: nirMatch ? nirMatch[1].replace(/\s/g, '') : null,
      dateNaissance: dobMatch ? formatDate(dobMatch[1]) : null
    } : null,
    devis: {
      date: creationMatch ? formatDate(creationMatch[1]) : null,
      praticien: praticienMatch ? praticienMatch[1] : null,
      totaux: totalsMatch ? {
        honoraires: totalsMatch[1],
        base: totalsMatch[2],
        amo: totalsMatch[3],
        reste: totalsMatch[4]
      } : null
    },
    actes
  };
}

function formatDate(d) {
  if (!d || d.length !== 8) return d;
  return `${d.substring(6,8)}/${d.substring(4,6)}/${d.substring(0,4)}`;
}

module.exports = { setLogger, readCurrentDevis, parseDevisXml, readPatientEmail, readPatientIdentity };
