# Lit le devis Logos depuis la RAM, filtré par nom patient
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File read-logos-devis.ps1 `
#     -OutputFile C:\path\out.bin -PatientFilter "DA SILVA VARELA"
#
# Si PatientFilter fourni, on ne garde QUE les dumps memoire contenant
# nomPatient="<PatientFilter>" - evite de lire un vieux devis en cache.

param(
    [string]$OutputFile = "",
    [string]$PatientFilter = ""
)

if (-not $OutputFile) { Write-Error "OutputFile required"; exit 1 }

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

    static bool ContainsAt(byte[] buf, int offset, byte[] needle) {
        if (offset + needle.Length > buf.Length) return false;
        for (int j = 0; j < needle.Length; j++) {
            if (buf[offset + j] != needle[j]) return false;
        }
        return true;
    }

    static int IndexOfBytes(byte[] buf, byte[] needle, int start, int end) {
        byte n0 = needle[0];
        int lim = end - needle.Length;
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

    public static byte[] FindAndDump(int pid, byte[] anchor, byte[] filterPattern, int beforeBytes, int afterBytes) {
        IntPtr h = OpenProcess(0x0010 | 0x0400, false, pid);
        if (h == IntPtr.Zero) return null;

        long addr = 0;
        long maxAddr = 4294967295L;
        int mbiSize = Marshal.SizeOf(typeof(MBI));
        MBI mbi;
        byte a0 = anchor[0];
        int anchorLen = anchor.Length;
        byte[] bestDump = null;
        int bestActes = -1;

        byte[] needleActe = Encoding.GetEncoding("iso-8859-1").GetBytes("<Ligne");

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
                    int limit = br - anchorLen;
                    for (int i = 0; i <= limit; i++) {
                        if (buf[i] != a0) continue;
                        if (!ContainsAt(buf, i, anchor)) continue;
                        int cs = Math.Max(0, i - beforeBytes);
                        int ce = Math.Min(br, i + anchorLen + afterBytes);
                        // Si filterPattern fourni, on doit le trouver dans la fenetre
                        if (filterPattern != null && filterPattern.Length > 0) {
                            if (IndexOfBytes(buf, filterPattern, cs, ce) < 0) continue;
                        }
                        // Compter le nb d'actes pour selectionner le meilleur dump
                        int countActes = 0;
                        int search = cs;
                        while (true) {
                            int found = IndexOfBytes(buf, needleActe, search, ce);
                            if (found < 0) break;
                            countActes++;
                            search = found + needleActe.Length;
                        }
                        if (countActes > bestActes) {
                            bestActes = countActes;
                            byte[] dump = new byte[ce - cs];
                            Array.Copy(buf, cs, dump, 0, dump.Length);
                            bestDump = dump;
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

$enc = [System.Text.Encoding]::GetEncoding("iso-8859-1")
$anchor = $enc.GetBytes('honorairesG=')

# Filtre par nom patient si fourni
$filter = $null
if ($PatientFilter -and $PatientFilter.Length -gt 0) {
    $filter = $enc.GetBytes('nomPatient="' + $PatientFilter + '"')
}

$dump = [LMR]::FindAndDump($proc.Id, $anchor, $filter, 8000, 16000)
if (-not $dump) {
    if ($filter) {
        Write-Error "No devis found for patient '$PatientFilter'"
    } else {
        Write-Error "No devis found in memory"
    }
    exit 2
}

[System.IO.File]::WriteAllBytes($OutputFile, $dump)
Write-Output "OK $($dump.Length)"
