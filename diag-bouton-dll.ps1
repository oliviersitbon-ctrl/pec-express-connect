# Diagnostic du bouton injecte (DLL dans Logos). Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_diag-bouton.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

Say "----- Taches planifiees -----"
foreach($tn in @('PecExpressInjector','PecExpressWatchdog')){
  $t = Get-ScheduledTask -TaskName $tn -ErrorAction SilentlyContinue
  if($t){ $i=Get-ScheduledTaskInfo -TaskName $tn -ErrorAction SilentlyContinue
    Say ("  $tn : PRESENTE, State=$($t.State), LastRun=$($i.LastRunTime), LastResult=$($i.LastTaskResult)") }
  else { Say "  $tn : ABSENTE" }
}

Say ""; Say "----- App installee ? -----"
$inst = "C:\Program Files\Mon devis dentaire Connecté"
Say ("  $inst : " + (Test-Path $inst))
foreach($f in @("$inst\resources\native\cabflow-logos-injector.exe","$inst\resources\native\cabflow-logos-bridge.dll","$inst\resources\resources\win\injector-task.ps1")){
  Say ("  " + (Test-Path $f) + "  $f")
}

Say ""; Say "----- Fichiers natifs sur le Bureau (dev) -----"
$dev = "$env:USERPROFILE\Desktop\pec-express-connect\resources\native"
Get-ChildItem $dev -ErrorAction SilentlyContinue | ForEach-Object { Say ("  {0,10} o  {1}" -f $_.Length,$_.Name) }

Say ""; Say "----- DLL injectee dans Logos ACTUELLEMENT ? -----"
$lg = Get-Process LOGOS_w -ErrorAction SilentlyContinue
if(-not $lg){ Say "  Logos non lance" }
else {
  foreach($p in $lg){
    $m = $null
    try { $m = $p.Modules | Where-Object { $_.ModuleName -match 'cabflow' } } catch {}
    Say ("  PID $($p.Id) : " + $(if($m){'DLL cabflow PRESENTE (' + ($m.ModuleName -join ',') + ')'}else{'pas de DLL cabflow'}))
  }
}

Say ""; Say "----- Dernieres lignes du log injecteur -----"
$lf = "C:\ProgramData\PecExpress\injector-task.log"
if(Test-Path $lf){ Get-Content $lf -Tail 15 | ForEach-Object { Say "  $_" } } else { Say "  (pas de log injecteur)" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
