# Liste le dossier du projet WinDev pour retrouver une sauvegarde de l'analyse
# d'avant la modif (pre-memo), afin de restaurer une analyse qui lit/ecrit.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_list-project.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$dirs = @("C:\My Projects\My_Project", "C:\My Projects")
foreach($d in $dirs){
  if(Test-Path $d){
    Say "===== $d ====="
    Get-ChildItem -Path $d -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Extension -match '\.(wdd|wda|bak|~*|zip)$' -or $_.Name -match 'wdd' } |
      Sort-Object LastWriteTime -Descending |
      ForEach-Object { Say ("  {0,-55} {1,8} o  {2}" -f $_.FullName.Replace($d+'\',''), $_.Length, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')) }
  } else { Say "(absent) $d" }
}

# Dossiers de versions/backup typiques de WinDev
Say "----- sous-dossiers du projet -----"
if(Test-Path "C:\My Projects\My_Project"){
  Get-ChildItem "C:\My Projects\My_Project" -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { Say ("  [DIR] {0}   ({1})" -f $_.Name, $_.LastWriteTime.ToString('yyyy-MM-dd HH:mm')) }
}

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
