# Force Chrome au premier plan (Windows)
# Utilise AttachThreadInput pour bypasser la restriction Windows
# qui empeche une app de voler le focus a une autre.

$ErrorActionPreference = 'SilentlyContinue'

$__mddDll = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..\native\MddNative.dll' } else { $null }
if ($__mddDll -and (Test-Path -LiteralPath $__mddDll) -and -not ('WFG' -as [type])) {
  try { Add-Type -Path $__mddDll -ErrorAction Stop } catch { }
}
if (-not ('WFG' -as [type])) {
Add-Type @'
using System;
using System.Runtime.InteropServices;
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
'@
}

for ($i = 0; $i -lt 15; $i++) {
    Start-Sleep -Milliseconds 200
    $p = Get-Process chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Sort-Object StartTime -Descending |
        Select-Object -First 1
    if ($p) {
        $h = $p.MainWindowHandle
        $fg = [WFG]::GetForegroundWindow()
        [uint32]$fgPid = 0
        $fgThread = [WFG]::GetWindowThreadProcessId($fg, [ref]$fgPid)
        $myThread = [WFG]::GetCurrentThreadId()
        [WFG]::AttachThreadInput($myThread, $fgThread, $true) | Out-Null
        [WFG]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
        [WFG]::BringWindowToTop($h) | Out-Null
        [WFG]::SetForegroundWindow($h) | Out-Null
        [WFG]::SwitchToThisWindow($h, $true) | Out-Null
        [WFG]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null
        Write-Host "Chrome foreground OK (PID=$($p.Id))"
        exit 0
    }
}
Write-Host "Chrome window not found after 3s"
exit 1
