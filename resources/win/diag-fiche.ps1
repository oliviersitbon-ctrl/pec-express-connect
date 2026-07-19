# Diagnostic fiche patient Logos : dumpe les fenetres top-level de LOGOS_w et
# leurs controles (classe / texte / position). A lancer PENDANT que la page
# "Etat civil" (fiche patient) est affichee au premier plan.
#
# Usage (dans le terminal PowerShell) :
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Utilisateur\Desktop\pec-express-connect\resources\win\diag-fiche.ps1"
#
# Copie-colle TOUTE la sortie dans le chat.

$__mddDll = if ($PSScriptRoot) { Join-Path $PSScriptRoot '..\native\MddNative.dll' } else { $null }
if ($__mddDll -and (Test-Path -LiteralPath $__mddDll) -and -not ('DG' -as [type])) {
  try { Add-Type -Path $__mddDll -ErrorAction Stop } catch { }
}
if (-not ('DG' -as [type])) {
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
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
"@
}

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Write-Output "LOGOS_w non lance"; exit 1 }
$pid0 = $proc.Id
$fg = [DG]::GetForegroundWindow()
$fgId = $fg.ToInt64()
Write-Output ("=== Foreground HWND = " + $fgId + " ===")

$tops = New-Object System.Collections.ArrayList
$cbTop = [DG+EnumProc]{ param($h,$l)
  if ([DG]::IsWindowVisible($h)) {
    $pp=0; [DG]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $pid0) {
      $sb=New-Object System.Text.StringBuilder(512); [DG]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object DG+RECT; [DG]::GetWindowRect($h,[ref]$r) | Out-Null
      $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
      if ($w -gt 200 -and $hh -gt 150) {
        [void]$script:tops.Add([PSCustomObject]@{ H=$h; Id=$h.ToInt64(); Title=$sb.ToString(); L=$r.Left; T=$r.Top; W=$w; Ht=$hh })
      }
    }
  }
  return $true
}
[DG]::EnumWindows($cbTop,[IntPtr]::Zero) | Out-Null

foreach ($t in $script:tops) {
  $fgMark = ""; if ($t.Id -eq $fgId) { $fgMark = "  <== FOREGROUND" }
  Write-Output ""
  Write-Output ("################ WINDOW id=" + $t.Id + " title='" + $t.Title + "' size=" + $t.W + "x" + $t.Ht + " @(" + $t.L + "," + $t.T + ")" + $fgMark)
  $rows = New-Object System.Collections.ArrayList
  $cbc = [DG+EnumProc]{ param($h,$l)
    if ([DG]::IsWindowVisible($h)) {
      $cls=New-Object System.Text.StringBuilder(80); [DG]::GetClassName($h,$cls,80) | Out-Null
      $sb=New-Object System.Text.StringBuilder(160); [DG]::GetWindowText($h,$sb,160) | Out-Null
      $txt=$sb.ToString()
      # On garde les controles qui ont du texte (boutons/labels) pour limiter le bruit.
      if ($txt.Trim().Length -gt 0) {
        $r=New-Object DG+RECT; [DG]::GetWindowRect($h,[ref]$r) | Out-Null
        [void]$script:rows.Add([PSCustomObject]@{ Cls=$cls.ToString(); Txt=$txt; L=$r.Left; T=$r.Top; R=$r.Right; B=$r.Bottom })
      }
    }
    return $true
  }
  [DG]::EnumChildWindows($t.H,$cbc,[IntPtr]::Zero) | Out-Null
  foreach ($row in $script:rows) {
    $short = $row.Txt; if ($short.Length -gt 60) { $short = $short.Substring(0,60) }
    Write-Output ("   [" + $row.Cls + "] '" + $short + "' @(" + $row.L + "," + $row.T + ")-(" + $row.R + "," + $row.B + ")")
  }
  Write-Output ("   (total controles avec texte: " + $script:rows.Count + ")")
}
Write-Output ""
Write-Output "=== FIN DIAG ==="
