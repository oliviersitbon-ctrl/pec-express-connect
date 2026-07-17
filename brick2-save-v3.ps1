# Brique 2 v3 - cible le champ "Nom du fichier" en le reperant PAR SON LIBELLE
# (meme ligne que le texte "Nom du fichier :"), puis focus + frappe clavier.
# Si le champ n'est pas identifie avec certitude -> NE TAPE RIEN (juste diagnostic),
# pour ne jamais renommer un vrai fichier par erreur.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$root = $AE::RootElement
$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_brick2-diag.txt"
$log = New-Object System.Collections.Generic.List[string]
function Say($m) { $log.Add($m); Write-Host $m }

$target = '\\PANO\wlogos2\Patients\LIENS\1720\Devis-brick2test.pdf'

# 0) Fermer une eventuelle fenetre d'erreur "Renommer"
$errCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Renommer')
$errDlg = $root.FindFirst($TS::Descendants, $errCond)
if ($errDlg) {
  $okCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'OK')
  $ok = $errDlg.FindFirst($TS::Descendants, $okCond)
  if ($ok) { try { $ok.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}; Say 'Erreur "Renommer" fermee.' }
  Start-Sleep -Milliseconds 400
}

# 1) Dialogue
$dlg = $null
for ($i = 0; $i -lt 15 -and -not $dlg; $i++) {
  $c = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Donnez un nom au fichier')
  $dlg = $root.FindFirst($TS::Descendants, $c)
  if (-not $dlg) { Start-Sleep -Milliseconds 300 }
}
if (-not $dlg) { Say 'Dialogue introuvable.'; $log | Out-File $out -Encoding UTF8; exit }
Say 'Dialogue trouve.'

# 2) Reperer le libelle texte "Nom du fichier"
$labelY = $null
$allDesc = $dlg.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
foreach ($e in $allDesc) {
  if ($e.Current.ControlType -eq $CT::Text -and $e.Current.Name -match 'Nom du fichier') {
    $labelY = [int]$e.Current.BoundingRectangle.Y
    Say "Libelle 'Nom du fichier' trouve a y=$labelY (x=$([int]$e.Current.BoundingRectangle.X))"
    break
  }
}

# 3) Lister tous les Edit/ComboBox (diagnostic complet)
$orCond = New-Object System.Windows.Automation.OrCondition(
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)),
  (New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::ComboBox))
)
$cands = $dlg.FindAll($TS::Descendants, $orCond)
Say "=== Edit/ComboBox: $($cands.Count) ==="
foreach ($e in $cands) {
  $r = $e.Current.BoundingRectangle
  $ctn = ($e.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')
  Say ("  [{0,-8}] name='{1}' auto='{2}' x={3} y={4} w={5}" -f $ctn, $e.Current.Name, $e.Current.AutomationId, [int]$r.X, [int]$r.Y, [int]$r.Width)
}

# 4) Choisir le champ sur la MEME LIGNE que le libelle (y proche), le plus large (le vrai champ)
$field = $null
if ($labelY -ne $null) {
  $best = -1
  foreach ($e in $cands) {
    $y = [int]$e.Current.BoundingRectangle.Y
    $w = [int]$e.Current.BoundingRectangle.Width
    if ([Math]::Abs($y - $labelY) -le 18 -and $w -gt $best) { $best = $w; $field = $e }
  }
  if ($field) { Say "Champ sur la ligne du libelle: name='$($field.Current.Name)' auto='$($field.Current.AutomationId)' w=$best" }
}

if (-not $field) {
  Say 'Champ NON identifie avec certitude -> aucune frappe (securite). Envoie-moi _brick2-diag.txt.'
  $log | Out-File $out -Encoding UTF8; exit
}

# Descendre sur Edit interne si ComboBox
$editTarget = $field
if ($field.Current.ControlType.ProgrammaticName -match 'ComboBox') {
  $ec = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Edit)
  $inner = $field.FindFirst($TS::Descendants, $ec)
  if ($inner) { $editTarget = $inner }
}

# 5) Focus + frappe clavier (chemin sans caractere special SendKeys)
try { $editTarget.SetFocus() } catch { Say "SetFocus KO: $($_.Exception.Message)" }
Start-Sleep -Milliseconds 250
[System.Windows.Forms.SendKeys]::SendWait("^a")
Start-Sleep -Milliseconds 120
[System.Windows.Forms.SendKeys]::SendWait($target)
Say "Chemin tape."
Start-Sleep -Milliseconds 350

# 6) Enregistrer
[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")
Say 'Entree envoyee.'
Start-Sleep -Milliseconds 700
if (-not (Test-Path $target)) {
  $btnCond = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, 'Enregistrer')
  $btn = $dlg.FindFirst($TS::Descendants, $btnCond)
  if ($btn) { try { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke(); Say 'Bouton Enregistrer (fallback).' } catch {} }
  Start-Sleep -Milliseconds 700
}

if (Test-Path $target) { Say "OK FICHIER PRESENT: $target" } else { Say "PAS ENCORE de fichier." }
$log | Out-File $out -Encoding UTF8
Write-Host "FIN"
