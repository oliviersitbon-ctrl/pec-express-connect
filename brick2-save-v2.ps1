# Brique 2 v2 - remplit le champ "Nom du fichier" du dialogue "Donnez un nom au fichier"
# puis Enregistrer. Cible le BON champ (Nom du fichier), pas la liste de fichiers.
# Ferme d'abord une eventuelle fenetre d'erreur "Renommer".

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$root = $AE::RootElement
$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_brick2-save.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

$target = '\\PANO\wlogos2\Patients\LIENS\1720\Devis-brick2test.pdf'

# 0) Fermer une eventuelle fenetre d'erreur "Renommer" (bouton OK)
$errCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Renommer')
$errDlg = $root.FindFirst($TS::Descendants, $errCond)
if ($errDlg) {
  $okCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'OK')
  $ok = $errDlg.FindFirst($TS::Descendants, $okCond)
  if ($ok) { try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Say 'Fenetre erreur "Renommer" fermee.' } catch {} }
  Start-Sleep -Milliseconds 300
}

# 1) Trouver le dialogue "Donnez un nom au fichier"
$dlg = $null
for ($i = 0; $i -lt 15 -and -not $dlg; $i++) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Donnez un nom au fichier')
  $dlg = $root.FindFirst($TS::Children, $c)
  if (-not $dlg) { $dlg = $root.FindFirst($TS::Descendants, $c) }
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Say 'Dialogue "Donnez un nom au fichier" introuvable. Ouvre-le (clic PDF) puis relance.'; $log | Out-File $out -Encoding UTF8; exit }
Say 'Dialogue trouve.'

# 2) DEBUG : lister tous les Edit et ComboBox du dialogue (Name + AutomationId + position)
$orCond = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ComboBox))
)
$cands = $dlg.FindAll($TS::Descendants, $orCond)
Say "=== Edit/ComboBox trouves: $($cands.Count) ==="
foreach ($e in $cands) {
  $r = $e.Current.BoundingRectangle
  $ctn = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')
  Say ("  [{0,-8}] name='{1}' auto='{2}' y={3}" -f $ctn, $e.Current.Name, $e.Current.AutomationId, [int]$r.Y)
}

# 3) Choisir le champ "Nom du fichier" : name contient 'Nom du fichier', sinon le plus bas
$field = $null
foreach ($e in $cands) { if ($e.Current.Name -match 'Nom du fichier') { $field = $e; break } }
if (-not $field -and $cands.Count -gt 0) {
  $maxY = -99999
  foreach ($e in $cands) { $y = [int]$e.Current.BoundingRectangle.Y; if ($y -gt $maxY) { $maxY = $y; $field = $e } }
  Say "Champ 'Nom du fichier' non nomme -> fallback sur le plus bas (y=$maxY)."
}
if (-not $field) { Say 'Aucun champ Nom du fichier.'; $log | Out-File $out -Encoding UTF8; exit }
Say ("Champ choisi: name='$($field.Current.Name)' type=$(($field.Current.ControlType.ProgrammaticName) -replace 'ControlType\.','')")

# Si c'est une ComboBox, descendre sur son Edit interne
$editTarget = $field
if ($field.Current.ControlType.ProgrammaticName -match 'ComboBox') {
  $ec = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)
  $inner = $field.FindFirst($TS::Descendants, $ec)
  if ($inner) { $editTarget = $inner; Say 'Edit interne de la ComboBox utilise.' }
}

# 4) Ecrire le chemin complet
try {
  $vp = $editTarget.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue($target)
  Say "Nom rempli: $target"
} catch { Say "SetValue KO: $($_.Exception.Message)"; $log | Out-File $out -Encoding UTF8; exit }
Start-Sleep -Milliseconds 500

# 5) Bouton "Enregistrer"
$btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Enregistrer')
$btn = $dlg.FindFirst($TS::Descendants, $btnCond)
if (-not $btn) { Say 'Bouton "Enregistrer" introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
try {
  $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Say 'Enregistrer -> Invoke envoye.'
} catch { Say "Invoke Enregistrer KO: $($_.Exception.Message)" }

Start-Sleep -Milliseconds 900
# 6) Verifier la presence du fichier
if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier a $target" }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
