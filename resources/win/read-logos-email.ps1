# Lit l'EMAIL du patient depuis la RAM de LOGOS_w.exe.
#
# L'email n'est pas dans le devis, mais dans la fiche patient (Etat civil >
# Coordonnees). Quand le dossier patient est ouvert dans Logos, ses champs
# (nom, telephone, email, adresse) sont en memoire. On scanne la memoire du
# process a la recherche d'adresses email situees PRES du nom de famille du
# patient (ancre), pour ne pas confondre avec l'email du praticien ou un email
# en cache d'un autre patient.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File read-logos-email.ps1 `
#     -Nom "LEBORGNE" [-Nir "240017502600791"] [-ExcludeDomain "cabinet.fr"] `
#     -OutputFile C:\tmp\email.txt
#
# Ecrit l'email trouve dans OutputFile (et sur stdout). Code retour 0 si trouve.

param(
    [Parameter(Mandatory=$true)][string]$Nom,
    [string]$Nir = "",
    [string]$ExcludeDomain = "",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Continue"

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class LEM {
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

    // Collecte toutes les fenetres (±window octets) autour de chaque occurrence
    // d'une des ancres (Latin1 ou UTF-16LE du nom). Retourne le blob concatene.
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

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Error "Logos (LOGOS_w) non lance"; exit 1 }

# Ancres = nom de famille en Latin1 ET en UTF-16LE (WinDev stocke souvent l'UI en UTF-16)
$nomUp = $Nom.Trim().ToUpper()
$lat = [System.Text.Encoding]::GetEncoding("iso-8859-1")
$uni = [System.Text.Encoding]::Unicode
$anchors = New-Object 'System.Collections.Generic.List[byte[]]'
$anchors.Add($lat.GetBytes($nomUp))
$anchors.Add($uni.GetBytes($nomUp))
if ($Nir) {
    $nirDigits = ($Nir -replace '\s','')
    $anchors.Add($lat.GetBytes($nirDigits))
}

$blob = [LEM]::CollectAroundAnchors($proc.Id, $anchors.ToArray(), 4000, 8000000)
if (-not $blob -or $blob.Length -eq 0) {
    Write-Error "Nom '$nomUp' introuvable en memoire (le dossier patient est-il ouvert ?)"
    exit 2
}

# Decode le blob en Latin1 ET en UTF-16LE, puis cherche les emails dans les deux.
$texts = @(
    $lat.GetString($blob),
    $uni.GetString($blob)
)
$rx = [regex]'[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}'
$found = New-Object System.Collections.Generic.List[string]
foreach ($t in $texts) {
    foreach ($m in $rx.Matches($t)) {
        $e = $m.Value.Trim().TrimEnd('.').ToLower()
        if ($e.Length -lt 6) { continue }
        if ($ExcludeDomain -and $e.EndsWith("@" + $ExcludeDomain.ToLower())) { continue }
        # Filtre les faux positifs techniques courants
        if ($e -match 'example\.|logos|windev|pcsoft|@w\.|\.png|\.jpg|\.dll|localhost') { continue }
        $found.Add($e)
    }
}

if ($found.Count -eq 0) { Write-Error "Aucun email trouve pres du patient"; exit 3 }

# Email le plus frequent pres de l'ancre = le bon
$best = ($found | Group-Object | Sort-Object Count -Descending | Select-Object -First 1).Name

if ($OutputFile) { Set-Content -Path $OutputFile -Value $best -NoNewline -Encoding UTF8 }
Write-Output $best
exit 0
