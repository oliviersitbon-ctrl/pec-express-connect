# Brique 2 v4 - remonte a la FENETRE de niveau superieur du dialogue de sauvegarde,
# puis trouve la ComboBox "Nom du fichier :" (vrai controle Windows standard).
# Dump complet des Edit/ComboBox de la fenetre pour diagnostic.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$root = $AE::RootElement
$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_brick2-diag2.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

$target = '\\PANO\wlogos2\Patients\LIENS\1720\Devis-brick2test.pdf'

# 0) Fermer erreur "Renommer" si presente
$errDlg = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Renommer')))
if ($errDlg) {
  $ok = $errDlg.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'OK')))
  if ($ok) { try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}; Say 'Erreur "Renommer" fermee.' }
  Start-Sleep -Milliseconds 400
}

# 1) Trouver l'element "Donnez un nom au fichier" puis REMONTER a la fenetre de niveau 1
$el = $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Donnez un nom au fichier')))
if (-not $el) { Say 'Dialogue introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
$win = $el
while ($true) {
  $parent = $walker.GetParent($win)
  if (-not $parent) { break }
  if ($parent -eq $root) { break }
  $win = $parent
}
Say ("Fenetre: name='$($win.Current.Name)' type=$(($win.Current.ControlType.ProgrammaticName) -replace 'ControlType\.','')")

# 2) Dump complet Edit/ComboBox de la fenetre
$orCond = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ComboBox))
)
$cands = $win.FindAll($TS::Descendants, $orCond)
Say "=== Edit/ComboBox de la fenetre: $($cands.Count) ==="
foreach ($e in $cands) {
  $r = $e.Current.BoundingRectangle
  $ctn = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')
  Say ("  [{0,-8}] name='{1}' auto='{2}' x={3} y={4} w={5}" -f $ctn, $e.Current.Name, $e.Current.AutomationId, [int]$r.X, [int]$r.Y, [int]$r.Width)
}

# 3) Champ "Nom du fichier" : ComboBox dont Name contient 'Nom du fichier', sinon Edit auto 1001/1148/1152
$field = $null
foreach ($e in $cands) { if ($e.Current.ControlType -eq $CT::ComboBox -and $e.Current.Name -match 'Nom du fichier') { $field = $e; break } }
if (-not $field) { foreach ($e in $cands) { if ($e.Current.Name -match 'Nom du fichier') { $field = $e; break } } }
if (-not $field) { foreach ($e in $cands) { if ($e.Current.AutomationId -in @('1001','1148','1152')) { $field = $e; break } } }

if (-not $field) {
  Say 'Champ "Nom du fichier" toujours introuvable -> aucune frappe. Envoie _brick2-diag2.txt.'
  $log | Out-File $out -Encoding UTF8; exit
}
Say ("CHAMP TROUVE: name='$($field.Current.Name)' auto='$($field.Current.AutomationId)' type=$(($field.Current.ControlType.ProgrammaticName) -replace 'ControlType\.','')")

# Edit interne si ComboBox
$editTarget = $field
if ($field.Current.ControlType -eq $CT::ComboBox) {
  $inner = $field.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)))
  if ($inner) { $editTarget = $inner }
}

# 4) Essayer ValuePattern d'abord (rapide), sinon focus+SendKeys
$typed = $false
try {
  $vp = $editTarget.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $vp.SetValue($target)
  Say "Nom rempli via ValuePattern."
  $typed = $true
} catch { Say "ValuePattern KO: $($_.Exception.Message)" }

if (-not $typed) {
  try { $editTarget.SetFocus(); Say 'Focus OK.' } catch { Say "SetFocus KO: $($_.Exception.Message)" }
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait("^a"); Start-Sleep -Milliseconds 120
  [System.Windows.Forms.SendKeys]::SendWait($target)
  Say 'Chemin tape au clavier.'
}
Start-Sleep -Milliseconds 400

# 5) Enregistrer
$btn = $win.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Enregistrer')))
if ($btn) {
  try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Say 'Enregistrer -> Invoke.' }
  catch { Say "Invoke Enregistrer KO: $($_.Exception.Message)"; $editTarget.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Say 'Entree envoyee.' }
} else {
  $editTarget.SetFocus(); [System.Windows.Forms.SendKeys]::SendWait("{ENTER}"); Say 'Bouton absent -> Entree.'
}

Start-Sleep -Milliseconds 900
if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
