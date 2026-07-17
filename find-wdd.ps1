# Cherche toutes les analyses .WDD/.WDA et le CabFlowReader, et affiche le format
# (premiers octets) pour distinguer ancien (5.5) vs recent.
$ErrorActionPreference='SilentlyContinue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_find-wdd.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$roots = @(
  "$env:USERPROFILE\Desktop\pec-express-connect",
  "$env:USERPROFILE\Desktop\pec-express",
  "C:\wlogos1",
  "C:\Users\Utilisateur\PecExpress"
)
Say "=== Fichiers .WDD / .WDA trouves ==="
foreach($r in $roots){
  if(Test-Path $r){
    Get-ChildItem -Path $r -Recurse -Depth 4 -Include '*.wdd','*.wda' -ErrorAction SilentlyContinue | ForEach-Object {
      $b=[IO.File]::ReadAllBytes($_.FullName)[0..15]
      $asc=($b | ForEach-Object { if($_ -ge 32 -and $_ -lt 127){[char]$_}else{'.'} }) -join ''
      $hex=($b | ForEach-Object { '{0:x2}' -f $_ }) -join ' '
      Say ("  {0}  ({1} o)" -f $_.FullName, $_.Length)
      Say ("     debut: $hex | $asc")
    }
  }
}
Say "=== CabFlowReader / *.exe du connecteur ==="
foreach($r in @("$env:USERPROFILE\Desktop\pec-express-connect","$env:USERPROFILE\Desktop\pec-express","C:\Users\Utilisateur\PecExpress")){
  if(Test-Path $r){
    Get-ChildItem -Path $r -Recurse -Depth 4 -Include 'CabFlow*','*.exe' -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Say ("  " + $_.FullName) }
  }
}
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
