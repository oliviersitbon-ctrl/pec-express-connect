# Brique 2 v7 - CIBLAGE EXACT : champ "Nom du fichier" = Edit id=1001 (parent ComboBox),
# bouton = Button id=1 ('&Enregistrer'). WM_SETTEXT + BM_CLICK. Win32, ne gele pas.
# Ouvre la fenetre "Donnez un nom au fichier" (clic PDF) PUIS lance ce script (attend 30 s).

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
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageTimeoutW")] public static extern IntPtr SMTText(IntPtr h, uint msg, IntPtr wp, string lp, uint flags, uint to, out IntPtr res);
  [DllImport("user32.dll", EntryPoint="SendMessageTimeout")] public static extern IntPtr SMTInt(IntPtr h, uint msg, IntPtr wp, IntPtr lp, uint flags, uint to, out IntPtr res);
  public static List<IntPtr> Tops(){ var l=new List<IntPtr>(); EnumWindows((h,x)=>{ l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p){ var l=new List<IntPtr>(); EnumChildWindows(p,(h,x)=>{ l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static string Cls(IntPtr h){ var s=new StringBuilder(256); GetClassName(h,s,256); return s.ToString(); }
  public static string Txt(IntPtr h){ var s=new StringBuilder(512); GetWindowText(h,s,512); return s.ToString(); }
}
"@

$WM_SETTEXT=0x000C; $BM_CLICK=0x00F5; $SMTO=0x0002

function Find-Dlg {
  foreach ($h in [W32]::Tops()) {
    if (-not [W32]::IsWindowVisible($h)) { continue }
    $t=[W32]::Txt($h)
    if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h }
  }
  $lp = Get-Process LOGOS_w -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lp) { foreach ($h in [W32]::Kids($lp.MainWindowHandle)) { $t=[W32]::Txt($h); if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h } } }
  return [IntPtr]::Zero
}

# 1) Attendre la fenetre
$hDlg=[IntPtr]::Zero
for ($i=0; $i -lt 60 -and $hDlg -eq [IntPtr]::Zero; $i++) { $hDlg=Find-Dlg; if ($hDlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 } }
if ($hDlg -eq [IntPtr]::Zero) { Say 'Fenetre introuvable (30 s). Reclique PDF et relance.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("Fenetre hwnd=$hDlg titre='$([W32]::Txt($hDlg))'")

# 2) Cibler l'Edit id=1001 (champ nom) et le Button id=1 (Enregistrer)
$edit=[IntPtr]::Zero; $save=[IntPtr]::Zero
foreach ($h in [W32]::Kids($hDlg)) {
  $id=[W32]::GetDlgCtrlID($h); $cls=[W32]::Cls($h)
  if ($cls -eq 'Edit' -and $id -eq 1001) { $edit=$h }
  if ($cls -eq 'Button' -and $id -eq 1) { $save=$h }
}
# fallback edit : Edit dont le parent est ComboBox
if ($edit -eq [IntPtr]::Zero) {
  foreach ($h in [W32]::Kids($hDlg)) { if ([W32]::Cls($h) -eq 'Edit') { $edit=$h } }  # dernier Edit
}
if ($edit -eq [IntPtr]::Zero) { Say 'Edit id=1001 introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("Champ nom hwnd=$edit ; bouton hwnd=$save")

# 3) Ecrire le chemin dans l'Edit id=1001
$res=[IntPtr]::Zero
[W32]::SMTText($edit,[uint32]$WM_SETTEXT,[IntPtr]::Zero,$target,$SMTO,3000,[ref]$res)|Out-Null
Start-Sleep -Milliseconds 300
Say ("Texte du champ apres ecriture: '$([W32]::Txt($edit))'")

# 4) Cliquer Enregistrer (id=1)
if ($save -ne [IntPtr]::Zero) {
  [W32]::SMTInt($save,[uint32]$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero,$SMTO,3000,[ref]$res)|Out-Null
  Say 'Enregistrer clique (id=1).'
} else { Say 'Bouton Enregistrer (id=1) introuvable.' }

Start-Sleep -Milliseconds 1500
if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier (verifie si un popup s-est ouvert)." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
