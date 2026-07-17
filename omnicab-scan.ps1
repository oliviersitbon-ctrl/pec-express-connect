# Cherche comment OmniCab injecte son bouton dans Logos (traces fichiers, DLL,
# config, entrees INI, registre). Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_omnicab-scan.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Processus en cours contenant omni / logos
Say "----- Processus (omni / logos / addin) -----"
Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'omni|logos|addin|plugin' } |
  ForEach-Object { try { Say ("  {0} (PID {1}) -> {2}" -f $_.ProcessName,$_.Id,$_.Path) } catch { Say ("  {0} (PID {1})" -f $_.ProcessName,$_.Id) } }

# 2) Fichiers contenant "omnicab" dans les emplacements probables
Say ""; Say "----- Fichiers/dossiers 'omni*' -----"
$roots = @("C:\wlogos1","C:\Program Files","C:\Program Files (x86)","C:\ProgramData","$env:APPDATA","$env:LOCALAPPDATA","$env:USERPROFILE\Desktop")
foreach($r in $roots){
  if(Test-Path $r){
    Get-ChildItem $r -Recurse -ErrorAction SilentlyContinue -Depth 3 |
      Where-Object { $_.Name -match 'omni' } |
      Select-Object -First 40 |
      ForEach-Object { Say ("  {0}" -f $_.FullName) }
  }
}

# 3) Contenu du dossier programme Logos : DLL tierces, plugins, addins
Say ""; Say "----- C:\wlogos1 : DLL et fichiers de config -----"
if(Test-Path "C:\wlogos1"){
  Get-ChildItem "C:\wlogos1" -Recurse -ErrorAction SilentlyContinue -Depth 2 |
    Where-Object { $_.Extension -match '\.(dll|ini|xml|json|cfg|conf|wdk|wl|dat)$' } |
    Sort-Object Length -Descending | Select-Object -First 60 |
    ForEach-Object { Say ("  {0,10} o  {1}" -f $_.Length, $_.FullName.Replace('C:\wlogos1\','')) }
}

# 4) Chercher 'omni' ou 'bouton'/'button' dans les .ini de Logos
Say ""; Say "----- Reference 'omni' dans les .ini de Logos -----"
Get-ChildItem "C:\wlogos1" -Filter *.ini -Recurse -ErrorAction SilentlyContinue |
  ForEach-Object {
    $f=$_.FullName
    try { $c = Get-Content $f -Raw -ErrorAction SilentlyContinue
      if($c -match 'omni'){ Say ("  [$f] contient 'omni'")
        ($c -split "`n") | Where-Object { $_ -match 'omni' } | Select-Object -First 8 | ForEach-Object { Say ("      " + $_.Trim()) }
      }
    } catch {}
  }

# 5) Registre : cles mentionnant omnicab
Say ""; Say "----- Registre 'omnicab' -----"
foreach($base in @("HKLM:\SOFTWARE","HKCU:\SOFTWARE")){
  Get-ChildItem $base -ErrorAction SilentlyContinue | Where-Object { $_.PSChildName -match 'omni' } |
    ForEach-Object { Say ("  $($_.Name)") }
}

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
