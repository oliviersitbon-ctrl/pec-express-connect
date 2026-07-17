# Lit l'IDENTITE du patient (date de naissance + email) depuis la RAM de
# LOGOS_w.exe quand la fiche patient (Etat civil) est ouverte.
#
# Principe (identique a read-logos-email.ps1) : on scanne la memoire du process
# autour des occurrences du NOM de famille (ancre, Latin1 + UTF-16LE), puis on
# cherche dans ce blob :
#   - le NIR (n de securite sociale) -> donne sexe + annee + mois de naissance
#   - la DATE DE NAISSANCE complete "JJ/MM/AAAA". Pour eviter de confondre avec
#     les autres dates de la fiche (Verifie le, 1er RDV...), on privilegie la
#     date dont MM/AAAA correspond au NIR (ex. NIR "2 59 08.." -> .../08/1959).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File read-logos-patient.ps1 `
#     -Nom "REY" -OutputFile C:\tmp\patient.json
#
# Ecrit un JSON { dob, nir, email } dans OutputFile (et sur stdout). Code 0 si DOB trouvee.

param(
    [Parameter(Mandatory=$true)][string]$Nom,
    [string]$ExcludeDomain = "",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class LPT {
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

    static int IndexOf(byte[] buf, byte[] needle, int start, int end) {
        if (needle.Length == 0) return -1;
        byte n0 = needle[0];
        int lim = Math.Min(end, buf.Length) - needle.Length;
        for (int i = start; i <= lim; i++) {
            if (buf[i] != n0) continue;
            bool m = true;
            for (int j = 1; j < needle.Length; j++) {
                if (buf[i+j] != needle[j]) { m = false; break; }
            }
            if (m) return i;
        }
        return -1;
    }

    public static byte[] CollectAroundAnchors(int pid, byte[][] anchors, int window, int maxTotal) {
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) return null;
        long addr = 0;
        long maxAddr = 0x7FFFFFFFFFFF;
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        MBI mbi;
        List<byte> outBuf = new List<byte>();
        while (addr < maxAddr && outBuf.Count < maxTotal) {
            if (VirtualQueryEx(h, new IntPtr(addr), out mbi, mbiSize) == 0) break;
            long rs = mbi.RegionSize.ToInt64();
            long ba = mbi.BaseAddress.ToInt64();
            uint pr = mbi.Protect;
            bool readable = (mbi.State == 0x1000) &&
                (pr == 0x04 || pr == 0x02 || pr == 0x20 || pr == 0x40);
            if (readable && rs > 0 && rs < 200 * 1024 * 1024L) {
                byte[] buf = new byte[rs];
                int br;
                if (ReadProcessMemory(h, mbi.BaseAddress, buf, (int)rs, out br) && br > 0) {
                    foreach (byte[] anchor in anchors) {
                        int from = 0;
                        while (true) {
                            int idx = IndexOf(buf, anchor, from, br);
                            if (idx < 0) break;
                            int cs = Math.Max(0, idx - window);
                            int ce = Math.Min(br, idx + anchor.Length + window);
                            for (int k = cs; k < ce; k++) outBuf.Add(buf[k]);
                            outBuf.Add(0x0A);
                            from = idx + anchor.Length;
                            if (outBuf.Count >= maxTotal) break;
                        }
                        if (outBuf.Count >= maxTotal) break;
                    }
                }
            }
            long na = ba + rs;
            if (na <= addr) break;
            addr = na;
        }
        CloseHandle(h);
        return outBuf.ToArray();
    }
}
"@ -ErrorAction SilentlyContinue

function Write-Result($obj) {
    $json = $obj | ConvertTo-Json -Compress
    if ($OutputFile) { Set-Content -Path $OutputFile -Value $json -NoNewline -Encoding UTF8 }
    Write-Output $json
}

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Error "Logos (LOGOS_w) non lance"; exit 1 }

$nomUp = $Nom.Trim().ToUpper()
$lat = [System.Text.Encoding]::GetEncoding("iso-8859-1")
$uni = [System.Text.Encoding]::Unicode
$anchors = New-Object 'System.Collections.Generic.List[byte[]]'
$anchors.Add($lat.GetBytes($nomUp))
$anchors.Add($uni.GetBytes($nomUp))

$blob = [LPT]::CollectAroundAnchors($proc.Id, $anchors.ToArray(), 4000, 8000000)
if (-not $blob -or $blob.Length -eq 0) {
    Write-Error "Nom '$nomUp' introuvable en memoire (fiche patient ouverte ?)"
    exit 2
}

$texts = @($lat.GetString($blob), $uni.GetString($blob))
$whole = [string]::Join("`n", $texts)

# 1) NIR : sexe(1) annee(2) mois(2) ... -> derive annee+mois de naissance.
$nir = $null; $yy = $null; $mm = $null
$nirRx = [regex]'\b([12])[\s]?(\d{2})[\s]?(\d{2})[\s]?\d{2}[\s]?\d{2,3}[\s]?\d{3}(?:[\s]?\d{2})?\b'
$nm = $nirRx.Match($whole)
if ($nm.Success) {
    $nir = ($nm.Value -replace '\s','')
    $yy = $nm.Groups[2].Value
    $mm = $nm.Groups[3].Value
}

# 2) Dates JJ/MM/AAAA presentes autour du patient.
$dateRx = [regex]'\b(\d{2})/(\d{2})/(\d{4})\b'
$dates = New-Object System.Collections.Generic.List[string]
foreach ($t in $texts) {
    foreach ($d in $dateRx.Matches($t)) { $dates.Add($d.Value) }
}

$dob = $null
# 2a) Priorite : date dont MM/AAAA colle au NIR (ex. .../08/1959).
if ($mm -and $yy) {
    $prefRx = [regex]("\b(\d{2})/" + [regex]::Escape($mm) + "/(?:19|20)" + [regex]::Escape($yy) + "\b")
    foreach ($t in $texts) {
        $pm = $prefRx.Match($t)
        if ($pm.Success) { $dob = $pm.Value; break }
    }
}
# 2b) Repli (NIR absent) : parmi les dates plausibles (1900..annee courante), on
#     prend celle dont l'ANNEE est la plus ANCIENNE = la date de naissance. Cela
#     evite la date de 1er RDV ou "verifie le" qui sont recentes.
if (-not $dob) {
    $curY = (Get-Date).Year
    $bestY = 9999
    foreach ($d in $dates) {
        $parts = $d.Split('/')
        $dd = [int]$parts[0]; $mo = [int]$parts[1]; $Y = [int]$parts[2]
        if ($dd -lt 1 -or $dd -gt 31 -or $mo -lt 1 -or $mo -gt 12) { continue }
        if ($Y -ge 1900 -and $Y -le $curY -and $Y -lt $bestY) { $bestY = $Y; $dob = $d }
    }
}

# 3) Email (bonus, non bloquant) - meme logique que read-logos-email.
$email = $null
$rxMail = [regex]'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'
$foundMail = New-Object System.Collections.Generic.List[string]
foreach ($t in $texts) {
    foreach ($m in $rxMail.Matches($t)) {
        $e = $m.Value.Trim().TrimEnd('.').ToLower()
        if ($e.Length -lt 6) { continue }
        if ($ExcludeDomain -and $e.EndsWith("@" + $ExcludeDomain.ToLower())) { continue }
        if ($e -match 'example\.|logos|windev|pcsoft|@w\.|\.png|\.jpg|\.dll|localhost') { continue }
        $foundMail.Add($e)
    }
}
if ($foundMail.Count -gt 0) {
    $email = ($foundMail | Group-Object | Sort-Object Count -Descending | Select-Object -First 1).Name
}

if (-not $dob) {
    Write-Result @{ dob = $null; nir = $nir; email = $email }
    Write-Error "Date de naissance introuvable pres du patient"
    exit 3
}

Write-Result @{ dob = $dob; nir = $nir; email = $email }
exit 0
