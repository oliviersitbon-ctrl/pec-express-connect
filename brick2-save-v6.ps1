# Brique 2 v6 - retrouve la fenetre "Donnez un nom au fichier" par ENUMERATION
# (top-level + enfants de Logos), sans dependre du titre exact. Puis dump Win32
# complet + remplissage du champ nom + clic Enregistrer. Ne gele pas.
# Lance le script PUIS clique PDF (il attend 30 s).

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
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SMTText(IntPtr h, uint msg, IntPtr wp, string lp, uint flags, uint to, out IntPtr res);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeout")] public static extern IntPtr SMTInt(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint to, out IntPtr res);
  public static List<IntPtr> Tops() { var l=new List<IntPtr>(); EnumWindows((h,x)=>{ l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p) { var l=new List<IntPtr>(); EnumChildWindows(p,(h,x)=>{ l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Txt(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
}
"@

$WM_SETTEXT=0x000C; $BM_CLICK=0x00F5; $SMTO=0x0002

function Find-Dlg {
  # a) top-level dont le titre contient "nom au fichier"
  foreach ($h in [W32]::Tops()) {
    if (-not [W32]::IsWindowVisible($h)) { continue }
    $t = [W32]::Txt($h)
    if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h }
  }
  # b) enfants de Logos
  $lp = Get-Process LOGOS_w -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lp) {
    foreach ($h in [W32]::Kids($lp.MainWindowHandle)) {
      $t = [W32]::Txt($h)
      if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h }
    }
  }
  return [IntPtr]::Zero
}

# 1) Attendre la fenetre (30 s)
$hDlg=[IntPtr]::Zero
for ($i=0; $i -lt 60 -and $hDlg -eq [IntPtr]::Zero; $i++) { $hDlg = Find-Dlg; if ($hDlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 } }

if ($hDlg -eq [IntPtr]::Zero) {
  Say 'Fenetre pas retrouvee par enumeration. Voici les fenetres top-level visibles avec titre :'
  foreach ($h in [W32]::Tops()) {
    if (-not [W32]::IsWindowVisible($h)) { continue }
    $t=[W32]::Txt($h); if ($t.Trim() -eq '') { continue }
    Say ("  hwnd=$h cls='$([W32]::Cls($h))' titre='$t'")
  }
  $log | Out-File $out -Encoding UTF8; exit
}
Say ("Fenetre trouvee hwnd=$hDlg cls='$([W32]::Cls($hDlg))' titre='$([W32]::Txt($hDlg))'")
$rd=New-Object W32+RECT; [W32]::GetWindowRect($hDlg,[ref]$rd)|Out-Null
Say ("rect L=$($rd.L) T=$($rd.T) R=$($rd.R) B=$($rd.B)")

# 2) Dump complet des enfants
$rows=@()
foreach ($h in [W32]::Kids($hDlg)) {
  $r=New-Object W32+RECT; [W32]::GetWindowRect($h,[ref]$r)|Out-Null
  $rows += [pscustomobject]@{ H=$h; Cls=[W32]::Cls($h); Id=[W32]::GetDlgCtrlID($h); PCls=[W32]::Cls([W32]::GetParent($h)); L=$r.L; T=$r.T; R=$r.R; B=$r.B; W=($r.R-$r.L); Txt=[W32]::Txt($h) }
}
Say "=== enfants: $($rows.Count) ==="
foreach ($x in ($rows | Sort-Object T,L)) {
  if ($x.Cls -match 'SysListView|DirectUIHWND|SysHeader|ScrollBar' -and $x.Txt -eq '') { continue }
  Say ("  cls='{0}' id={1} par='{2}' L={3} T={4} R={5} B={6} w={7} txt='{8}'" -f $x.Cls,$x.Id,$x.PCls,$x.L,$x.T,$x.R,$x.B,$x.W,$x.Txt)
}

# 3) Candidat champ nom : editable large dans le bas de la fenetre
$midY = $rd.T + [int](($rd.B-$rd.T)*0.55)
$cand=$null; $bestW=0
foreach ($x in $rows) {
  if ($x.Cls -match 'SysListView|DirectUIHWND|SysHeader|ScrollBar|Button|Static|Toolbar|Breadcrumb|Address|Search|CtrlNotifySink') { continue }
  if ($x.T -lt $midY) { continue }
  if ($x.W -gt $bestW) { $bestW=$x.W; $cand=$x }
}
if (-not $cand) { Say 'Pas de candidat champ nom -> dump seul. Envoie _brick2-win32.txt.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("CANDIDAT: cls='$($cand.Cls)' id=$($cand.Id) L=$($cand.L) T=$($cand.T) w=$($cand.W) txt='$($cand.Txt)'")

# 4) WM_SETTEXT
$res=[IntPtr]::Zero
[W32]::SMTText($cand.H,[uint32]$WM_SETTEXT,[IntPtr]::Zero,$target,$SMTO,3000,[ref]$res)|Out-Null
Start-Sleep -Milliseconds 300
Say ("Apres WM_SETTEXT: '$([W32]::Txt($cand.H))'")

# 5) Bouton Enregistrer
$save=$null
foreach ($x in $rows) { if ($x.Cls -eq 'Button' -and ($x.Txt -match 'Enregistrer' -or $x.Id -eq 1)) { $save=$x; break } }
if ($save) { [W32]::SMTInt($save.H,[uint32]$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero,$SMTO,3000,[ref]$res)|Out-Null; Say "Enregistrer clique (txt='$($save.Txt)')." }
else { Say 'Bouton Enregistrer introuvable.' }

Start-Sleep -Milliseconds 1200
if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
