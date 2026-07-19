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
// REGLE : les classes ci-dessous doivent rester STRICTEMENT identiques (nom,
// signatures, types imbriques) aux blocs inline des fichiers src/main/*.js.
// Toute modification d'un bloc inline doit etre repercutee ici, et inversement.
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

// === logos-memory-reader.js (classe LMR) — lecture memoire devis =============
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
