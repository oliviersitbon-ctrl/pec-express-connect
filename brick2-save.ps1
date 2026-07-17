# Brique 2 - automatise la fenetre "Donnez un nom au fichier" (Enregistrer sous)
# qui s'ouvre apres le clic PDF. Remplit le chemin exact dans LIENS et enregistre.
# Dialogue Windows standard -> UIA fiable (ValuePattern + InvokePattern).
# Pre-requis : la fenetre "Donnez un nom au fichier" doit etre OUVERTE.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$root = $AE::RootElement
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_brick2-save.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

# --- CHEMIN CIBLE (test) : dossier LIENS du patient 1720 ---
$target = '\\PANO\wlogos2\Patients\LIENS\1720\Devis-brick2test.pdf'

# 1) Trouver le dialogue "Donnez un nom au fichier"
$dlg = $null
for ($i = 0; $i -lt 15 -and -not $dlg; $i++) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Donnez un nom au fichier')
  $dlg = $root.FindFirst($TS::Children, $c)
  if (-not $dlg) { $dlg = $root.FindFirst($TS::Descendants, $c) }
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Say 'Dialogue "Donnez un nom au fichier" introuvable. Ouvre-le (clic bouton PDF) puis relance.'; $log | Out-File $out -Encoding UTF8; exit }
Say 'Dialogue trouve.'

# 2) Champ "Nom du fichier" (premier Edit du dialogue)
$editCond = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
$edit = $dlg.FindFirst($TS::Descendants, $editCond)
if (-not $edit) { Say 'Champ "Nom du fichier" introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
try {
  $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue($target)
  Say "Nom rempli via ValuePattern: $target"
} catch { Say "SetValue KO: $($_.Exception.Message)"; $log | Out-File $out -Encoding UTF8; exit }
Start-Sleep -Milliseconds 400

# 3) Bouton "Enregistrer"
$btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Enregistrer')
$btn = $dlg.FindFirst($TS::Descendants, $btnCond)
if (-not $btn) { Say 'Bouton "Enregistrer" introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
try {
  $ip = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $ip.Invoke()
  Say 'Enregistrer -> Invoke envoye.'
} catch { Say "Invoke Enregistrer KO: $($_.Exception.Message)" }

Start-Sleep -Milliseconds 800
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
