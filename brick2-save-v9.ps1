# Brique 2 v9 - enregistre le PDF sous Devis-<numero>.pdf (numero passe en parametre).
# Ex :  ...brick2-save-v9.ps1 1100        (patient 1720 par defaut)
#       ...brick2-save-v9.ps1 1100 1720
# Ouvre la fenetre PDF (clic PDF) PUIS lance ce script. Aucune souris. Gere "remplacer ?".

param([string]$Devis, [string]$Patient = '1720')

$ErrorActionPreference = 'SilentlyContinue'
$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_brick2-win32.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

if ([string]::IsNullOrWhiteSpace($Devis)) {
  Say 'Donne le numero du devis : ex.  powershell -ExecutionPolicy Bypass -File "...\brick2-save-v9.ps1" 1100'
  $log | Out-File $out -Encoding UTF8; exit
}
$target = "\\PANO\wlogos2\Patients\LIENS\$Patient\Devis-$Devis.pdf"
Say "Cible: $target"

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
  foreach ($h in [W32]::Tops()) { if ([W32]::IsWindowVisible($h)) { $t=[W32]::Txt($h); if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h } } }
  $lp = Get-Process LOGOS_w -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($lp) { foreach ($h in [W32]::Kids($lp.MainWindowHandle)) { $t=[W32]::Txt($h); if ($t -match 'nom au fichier' -or $t -match 'Enregistrer sous') { return $h } } }
  return [IntPtr]::Zero
}

# 1) Attendre la fenetre PDF
$hDlg=[IntPtr]::Zero
for ($i=0; $i -lt 60 -and $hDlg -eq [IntPtr]::Zero; $i++) { $hDlg=Find-Dlg; if ($hDlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 } }
if ($hDlg -eq [IntPtr]::Zero) { Say 'Fenetre PDF introuvable (30 s). Reclique PDF et relance.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("Fenetre PDF hwnd=$hDlg")

# 2) Champ nom (Edit id=1001) + bouton Enregistrer (id=1)
$edit=[IntPtr]::Zero; $save=[IntPtr]::Zero
foreach ($h in [W32]::Kids($hDlg)) { $id=[W32]::GetDlgCtrlID($h); $cls=[W32]::Cls($h); if ($cls -eq 'Edit' -and $id -eq 1001) { $edit=$h }; if ($cls -eq 'Button' -and $id -eq 1) { $save=$h } }
if ($edit -eq [IntPtr]::Zero) { Say 'Edit id=1001 introuvable.'; $log | Out-File $out -Encoding UTF8; exit }

# 3) Ecrire le nom + Enregistrer
$res=[IntPtr]::Zero
[W32]::SMTText($edit,[uint32]$WM_SETTEXT,[IntPtr]::Zero,$target,$SMTO,3000,[ref]$res)|Out-Null
Start-Sleep -Milliseconds 300
Say 'Nom ecrit dans le champ.'
if ($save -ne [IntPtr]::Zero) { [W32]::SMTInt($save,[uint32]$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero,$SMTO,3000,[ref]$res)|Out-Null; Say 'Enregistrer clique.' }

# 4) Popup "remplacer ?" -> Oui
Start-Sleep -Milliseconds 500
for ($k=0; $k -lt 10; $k++) {
  $done=$false
  foreach ($h in [W32]::Tops()) {
    if (-not [W32]::IsWindowVisible($h)) { continue }
    $t=[W32]::Txt($h)
    if ($t -match 'Confirmer' -or $t -match 'Enregistrer sous' -or $t -match 'remplacer') {
      foreach ($c in [W32]::Kids($h)) {
        if ([W32]::Cls($c) -eq 'Button' -and ([W32]::GetDlgCtrlID($c) -eq 6 -or [W32]::Txt($c) -match '^&?Oui')) {
          [W32]::SMTInt($c,[uint32]$BM_CLICK,[IntPtr]::Zero,[IntPtr]::Zero,$SMTO,3000,[ref]$res)|Out-Null
          Say 'Popup remplacer -> Oui.'; $done=$true; break
        }
      }
    }
    if ($done) { break }
  }
  if ($done) { break }
  Start-Sleep -Milliseconds 300
}

Start-Sleep -Milliseconds 1200
if (Test-Path $target) { $fi=Get-Item $target; Say ("OK FICHIER PRESENT: $target  ($($fi.Length) octets, $($fi.LastWriteTime))") } else { Say "PAS de fichier." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
