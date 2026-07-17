# Brique 2 v5 - reconnaissance Win32 COMPLETE du dialogue "Donnez un nom au fichier"
# + tentative de remplissage du meilleur candidat.
# FindWindow + EnumChildWindows + SendMessage (WM_SETTEXT / BM_CLICK), avec timeouts.
# Ne gele pas, ne renomme rien. Le script ATTEND la fenetre (30 s) : lance-le PUIS clique PDF.

$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_brick2-win32.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

$target = '\\PANO\wlogos2\Patients\LIENS\1720\Devis-brick2test.pdf'

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W32 {
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern IntPtr FindWindow(string cls, string title);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SMTText(IntPtr h, uint msg, IntPtr wp, string lp, uint flags, uint to, out IntPtr res);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeout")] public static extern IntPtr SMTInt(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint to, out IntPtr res);
  public static List<IntPtr> Kids(IntPtr parent) {
    var list = new List<IntPtr>();
    EnumChildWindows(parent, (h,l) => { list.Add(h); return true; }, IntPtr.Zero);
    return list;
  }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static string Txt(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
}
"@

$WM_SETTEXT = 0x000C
$BM_CLICK   = 0x00F5
$SMTO       = 0x0002

# 1) Attendre la fenetre (30 s)
$hDlg = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $hDlg -eq [IntPtr]::Zero; $i++) {
  $hDlg = [W32]::FindWindow($null, 'Donnez un nom au fichier')
  if ($hDlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
}
if ($hDlg -eq [IntPtr]::Zero) { Say 'Fenetre pas apparue (30 s). Reclique PDF et relance.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("Fenetre hwnd=$hDlg titre='$([W32]::Txt($hDlg))'")
$rd = New-Object W32+RECT; [W32]::GetWindowRect($hDlg, [ref]$rd) | Out-Null
Say ("Fenetre rect L=$($rd.L) T=$($rd.T) R=$($rd.R) B=$($rd.B)")

# 2) DUMP COMPLET de tous les enfants (classe/id/rect/texte)
$kids = [W32]::Kids($hDlg)
Say "=== TOUS les enfants: $($kids.Count) ==="
$rows = @()
foreach ($h in $kids) {
  $cls = [W32]::Cls($h)
  $id  = [W32]::GetDlgCtrlID($h)
  $r = New-Object W32+RECT; [W32]::GetWindowRect($h, [ref]$r) | Out-Null
  $txt = [W32]::Txt($h)
  $pcls = [W32]::Cls([W32]::GetParent($h))
  $rows += [pscustomobject]@{ H=$h; Cls=$cls; Id=$id; PCls=$pcls; L=$r.L; T=$r.T; R=$r.R; B=$r.B; W=($r.R-$r.L); Txt=$txt }
}
# on ignore les cellules de liste (SysListView / DirectUI) : on montre le reste
foreach ($x in ($rows | Sort-Object T, L)) {
  if ($x.Cls -match 'SysListView|DirectUIHWND|SysHeader|ScrollBar|Static' -and $x.Txt -eq '') { continue }
  Say ("  cls='{0}' id={1} par='{2}' L={3} T={4} R={5} B={6} w={7} txt='{8}'" -f $x.Cls, $x.Id, $x.PCls, $x.L, $x.T, $x.R, $x.B, $x.W, $x.Txt)
}

# 3) Candidat champ "Nom du fichier" : un Edit/ComboBox/WinDev large, sous la liste, a gauche.
#    Heuristique : controle editable le plus large dont le Top est dans le tiers bas de la fenetre.
$midY = $rd.T + ([int](($rd.B - $rd.T) * 0.6))
$cand = $null; $bestW = 0
foreach ($x in $rows) {
  if ($x.Cls -match 'SysListView|DirectUIHWND|SysHeader|ScrollBar|Static|Button|CtrlNotifySink|ToolbarWindow|Breadcrumb|Address|UniversalSearch|Search') { continue }
  if ($x.T -lt $midY) { continue }
  if ($x.W -gt $bestW) { $bestW = $x.W; $cand = $x }
}
if (-not $cand) {
  Say 'Aucun candidat champ nom en bas -> j-envoie juste le dump. Envoie _brick2-win32.txt.'
  $log | Out-File $out -Encoding UTF8; exit
}
Say ("CANDIDAT champ nom: cls='$($cand.Cls)' id=$($cand.Id) L=$($cand.L) T=$($cand.T) w=$($cand.W) txt='$($cand.Txt)'")

# 4) Ecrire le chemin (WM_SETTEXT) dans le candidat
$res = [IntPtr]::Zero
[W32]::SMTText($cand.H, [uint32]$WM_SETTEXT, [IntPtr]::Zero, $target, $SMTO, 3000, [ref]$res) | Out-Null
Start-Sleep -Milliseconds 300
$check = [W32]::Txt($cand.H)
Say ("Apres WM_SETTEXT, texte du champ = '$check'")

# 5) Bouton Enregistrer (Button avec texte 'Enregistrer' ou id=1)
$save = $null
foreach ($x in $rows) { if ($x.Cls -eq 'Button' -and ($x.Txt -match 'Enregistrer' -or $x.Id -eq 1)) { $save = $x; break } }
if ($save) {
  [W32]::SMTInt($save.H, [uint32]$BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero, $SMTO, 3000, [ref]$res) | Out-Null
  Say ("Bouton Enregistrer clique (cls='$($save.Cls)' id=$($save.Id) txt='$($save.Txt)').")
} else { Say 'Bouton Enregistrer introuvable.' }

Start-Sleep -Milliseconds 1200
if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
