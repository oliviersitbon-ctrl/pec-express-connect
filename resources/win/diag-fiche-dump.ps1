# Diagnostic APPROFONDI de la fiche patient Logos.
# Dumpe, dans un FICHIER, TOUS les controles (toutes classes : Button, Static,
# Edit, etc.) de la fenetre "Fiche d'etat civil" ET de la fenetre patient
# "<num> - <NOM>", avec classe / texte / position. But : reperer si le NUMERO de
# dossier et la DATE DE NAISSANCE sont lisibles directement (sans scan RAM).
#
# Usage (sur la page Etat civil au premier plan) :
#   powershell -ExecutionPolicy Bypass -File "C:\Users\Utilisateur\Desktop\pec-express-connect\resources\win\diag-fiche-dump.ps1"
# Puis dis-moi "c'est fait" — je lis le fichier _diag-fiche.txt automatiquement.

$OUT = "C:\Users\Utilisateur\Desktop\pec-express-connect\_diag-fiche.txt"

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
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
"@

$lines = New-Object System.Collections.ArrayList
function W($s) { [void]$script:lines.Add($s) }

$proc = Get-Process -Name "LOGOS_w" -ErrorAction SilentlyContinue
if (-not $proc) { Set-Content -Path $OUT -Value "LOGOS_w non lance"; exit 1 }
$pid0 = $proc.Id

# Lit le texte d'un controle : GetWindowText, sinon WM_GETTEXT (0x000D).
function CtrlText($h) {
  $sb = New-Object System.Text.StringBuilder(512)
  [DG2]::GetWindowText($h, $sb, 512) | Out-Null
  $t = $sb.ToString()
  if ($t.Trim().Length -eq 0) {
    $sb2 = New-Object System.Text.StringBuilder(512)
    [DG2]::SendMessage($h, 0x000D, [IntPtr]256, $sb2) | Out-Null
    $t = $sb2.ToString()
  }
  return $t
}

$tops = New-Object System.Collections.ArrayList
$cbTop = [DG2+EnumProc]{ param($h,$l)
  if ([DG2]::IsWindowVisible($h)) {
    $pp=0; [DG2]::GetWindowThreadProcessId($h,[ref]$pp) | Out-Null
    if ($pp -eq $pid0) {
      $sb=New-Object System.Text.StringBuilder(512); [DG2]::GetWindowText($h,$sb,512) | Out-Null
      $r=New-Object DG2+RECT; [DG2]::GetWindowRect($h,[ref]$r) | Out-Null
      $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top
      if ($w -gt 300 -and $hh -gt 200) {
        [void]$script:tops.Add([PSCustomObject]@{ H=$h; Id=$h.ToInt64(); Title=$sb.ToString() })
      }
    }
  }
  return $true
}
[DG2]::EnumWindows($cbTop,[IntPtr]::Zero) | Out-Null

foreach ($t in $script:tops) {
  # On ne dumpe que la fiche etat civil et la fenetre patient "<num> - <nom>".
  $isFiche = ($t.Title -match 'tat civil')
  $isPatient = ($t.Title -match '^\d+\s*[-–]')
  if (-not ($isFiche -or $isPatient)) { continue }
  W ""
  W ("################ WINDOW id=" + $t.Id + " title='" + $t.Title + "'")
  $cbc = [DG2+EnumProc]{ param($h,$l)
    if ([DG2]::IsWindowVisible($h)) {
      $cls=New-Object System.Text.StringBuilder(80); [DG2]::GetClassName($h,$cls,80) | Out-Null
      $txt = CtrlText $h
      if ($txt.Trim().Length -gt 0) {
        $r=New-Object DG2+RECT; [DG2]::GetWindowRect($h,[ref]$r) | Out-Null
        $short = $txt; if ($short.Length -gt 70) { $short = $short.Substring(0,70) }
        W ("   [" + $cls.ToString() + "] '" + $short + "' @(" + $r.Left + "," + $r.Top + ")-(" + $r.Right + "," + $r.Bottom + ")")
      }
    }
    return $true
  }
  [DG2]::EnumChildWindows($t.H,$cbc,[IntPtr]::Zero) | Out-Null
}
W ""
W "=== FIN ==="
Set-Content -Path $OUT -Value ($script:lines -join "`r`n") -Encoding UTF8
Write-Output ("Ecrit: " + $OUT)
