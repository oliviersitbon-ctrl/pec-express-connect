# Diagnostic : liste TOUS les controles (descendants) des fenetres Logos, avec
# classe, texte et coordonnees ecran. N'effectue AUCUN clic. Ecrit le resultat
# dans _toolbar-probe.txt (a cote de ce script) pour analyse.
#
# A lancer AVEC Logos ouvert sur l'ecran Devis du patient, au premier plan.

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class TB {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@ -ErrorAction SilentlyContinue

$out = Join-Path $PSScriptRoot "_toolbar-probe.txt"
$L = New-Object System.Collections.Generic.List[string]

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { "LOGOS_w introuvable" | Out-File $out -Encoding UTF8; Write-Host "Logos pas lance"; exit }
$logosPid = $proc.Id

# Fenetres top-level Logos visibles
$tops = New-Object System.Collections.ArrayList
$cbTop = [TB+EnumProc]{ param($h,$l)
  if ([TB]::IsWindowVisible($h) -and -not [TB]::IsIconic($h)) {
    $pp=0; [TB]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $logosPid) {
      $sb=New-Object System.Text.StringBuilder(512); [TB]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object TB+RECT; [TB]::GetWindowRect($h,[ref]$r) | Out-Null
      $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
      if ($r.Left -gt -4000 -and $w -gt 100 -and $hh -gt 100) {
        [void]$script:tops.Add([PSCustomObject]@{ HWnd=$h; Title=$sb.ToString(); L=$r.Left; T=$r.Top; W=$w; H=$hh })
      }
    }
  }
  return $true
}
[TB]::EnumWindows($cbTop,[IntPtr]::Zero) | Out-Null

foreach ($top in $script:tops) {
  $L.Add("")
  $L.Add("===== FENETRE TOP-LEVEL : '" + $top.Title + "' pos(" + $top.L + "," + $top.T + ") taille " + $top.W + "x" + $top.H + " =====")
  $cbCh = [TB+EnumProc]{ param($h,$l)
    $cls=New-Object System.Text.StringBuilder(96); [TB]::GetClassName($h,$cls,96) | Out-Null
    $sb=New-Object System.Text.StringBuilder(256); [TB]::GetWindowText($h,$sb,256) | Out-Null
    $r=New-Object TB+RECT; [TB]::GetWindowRect($h,[ref]$r) | Out-Null
    $vis = [TB]::IsWindowVisible($h)
    $txt = $sb.ToString()
    $cx=[int](($r.Left+$r.Right)/2); $cy=[int](($r.Top+$r.Bottom)/2)
    # On ne garde que les controles visibles avec une taille raisonnable
    $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
    if ($vis -and $w -gt 4 -and $hh -gt 4) {
      $line = "  cls={0,-24} centre=({1},{2}) rect=({3},{4})-({5},{6}) txt='{7}'" -f `
        $cls.ToString(), $cx, $cy, $r.Left, $r.Top, $r.Right, $r.Bottom, $txt
      $script:L.Add($line)
    }
    return $true
  }
  [TB]::EnumChildWindows($top.HWnd,$cbCh,[IntPtr]::Zero) | Out-Null
}

$L | Out-File $out -Encoding UTF8
Write-Host ("Ecrit " + $L.Count + " lignes dans " + $out)
