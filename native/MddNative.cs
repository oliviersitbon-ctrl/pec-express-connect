// MddNative.cs — Types P/Invoke natifs du connecteur "Mon devis dentaire".
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// Historiquement, chaque script PowerShell du connecteur compilait son bloc C#
// au moment de l'execution via `Add-Type @"...C#..."@`. PowerShell delegue alors
// a csc.exe, qui produit une DLL a NOM ALEATOIRE dans %LOCALAPPDATA%\Temp
// (ex. odpoa1tv.dll). Comme ce code fait de l'inspection de fenetres et de la
// lecture memoire d'un autre processus (Logos), certains antivirus a heuristique
// (G DATA => "Gen:Variant.Adware") signalent ces DLL temporaires.
//
// LA CORRECTION
// -------------
// On PRECOMPILE ici, une fois pour toutes, TOUS les types natifs dans une seule
// DLL (`MddNative.dll`), signee LABORA et livree dans resources/native. A
// l'execution, les scripts chargent cette DLL via `Add-Type -Path` : plus aucune
// compilation runtime, donc plus aucune DLL temporaire, donc plus d'alerte AV.
// Le bloc `Add-Type @"..."@` inline reste present dans chaque script comme
// SECOURS (dev sans DLL compilee) : il n'est utilise que si le type n'est pas
// deja charge.
//
// SOURCES DES CLASSES
//   Overlays (src/main/*.js, PS inline via -Command) :
//     LD, PD, W32C, W32U, FD, FGH2, MDL, FGHook
//   Scripts livres (resources/win/*.ps1, executes via -File) :
//     LMR (read-logos-devis), LPT (read-logos-patient), LEM (read-logos-email),
//     DG (diag-fiche), DG2 (diag-fiche-dump), WFG (foreground-chrome)
//
// REGLE : les classes ci-dessous doivent rester STRICTEMENT identiques (nom,
// signatures, types imbriques) aux blocs inline correspondants. Toute
// modification d'un bloc inline doit etre repercutee ici, et inversement.
//
// Compile en .NET Framework 4.x (csc v4.0.30319) pour etre chargeable par
// Windows PowerShell 5.1. Voir scripts/build-native.cjs.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.IO;

// === logos-detector.js (classe LD) — detection fenetre devis active ==========
public class LD {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}

// === read-logos-devis.ps1 (classe LMR) — lecture memoire du devis ============
// NB : signature FindAndDump a 5 parametres (anchor + filterPattern), version
// AUTORITATIVE = celle du script livre read-logos-devis.ps1 (reellement executee).
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

// === logos-print-devis.js (classe PD) — shift+clic bouton Imprimer ===========
public class PD {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}

// === win32-utils.js (classe W32C) — SetParent + styles (attache) =============
public class W32C {
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public const int GWL_STYLE = -16;
    public const int WS_CHILD = 0x40000000;
    public const int WS_POPUP = unchecked((int)0x80000000);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_FRAMECHANGED = 0x0020;
}

// === win32-utils.js (classe W32U) — SetParent (detache) ======================
public class W32U {
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    public const int GWL_STYLE = -16;
    public const int WS_CHILD = 0x40000000;
    public const int WS_POPUP = unchecked((int)0x80000000);
}

// === overlay-fiche.js (classe FD) — detection page Etat civil + bouton Aide ==
public class FD {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}

// === overlay-fiche.js (classe FGH2) — hook WinEvent foreground (fiche) =======
public class FGH2 {
  public delegate void D(IntPtr a, uint b, IntPtr c, int d, int e, uint f, uint g);
  [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint mn, uint mx, IntPtr h, D cb, uint p, uint t, uint f);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint a, uint b);
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
}

// === overlay-md.js (classe MDL) — localisation bouton Imprimer devis =========
public class MDL {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}

// === overlay-pec.js (classe FGHook) — hook WinEvent foreground (pec) =========
public class FGHook {
    public delegate void WinEventDelegate(IntPtr hWinEventHook, uint eventType, IntPtr hwnd, int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint eventMin, uint eventMax, IntPtr hmodWinEventProc, WinEventDelegate lpfnWinEventProc, uint idProcess, uint idThread, uint dwFlags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hWinEventHook);
    [DllImport("user32.dll")] public static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG lpMsg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG lpMsg);
    [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int pt_x; public int pt_y; }
    public const uint EVENT_SYSTEM_FOREGROUND = 3;
    public const uint WINEVENT_OUTOFCONTEXT = 0;
}

// === read-logos-patient.ps1 (classe LPT) — lecture identite patient ==========
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

// === read-logos-email.ps1 (classe LEM) — lecture email patient ===============
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

// === diag-fiche.ps1 (classe DG) — diagnostic fenetres (outil) ================
public class DG {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}

// === diag-fiche-dump.ps1 (classe DG2) — diagnostic fenetres (outil) ==========
public class DG2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, StringBuilder l);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}

// === foreground-chrome.ps1 (classe WFG) — mise au premier plan ===============
public class WFG {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SwitchToThisWindow(IntPtr h, bool b);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint id1, uint id2, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
