# Extrait les noms de rubriques stockes dans l'en-tete de ACTES_2.fic (lecture seule).
# On connait deja les 60 premiers via l'ODBC ; on cherche surtout le 61e (le memo).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_fieldnames.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$fic = "L:\Patients\ACTES_2.fic"
if(-not (Test-Path $fic)){ Say "introuvable: $fic"; $L|Out-File $out -Encoding UTF8; exit }

# lire les premiers 16 Ko (l'en-tete + descripteurs de rubriques y sont)
$fs = [System.IO.File]::OpenRead($fic)
$buf = New-Object byte[] 16384
$null = $fs.Read($buf,0,16384); $fs.Close()

# extraire les suites de caracteres imprimables (noms de rubriques en MAJUSCULES/underscore/chiffres)
$cur = New-Object System.Text.StringBuilder
$runs = New-Object System.Collections.Generic.List[object]
for($i=0;$i -lt $buf.Length;$i++){
  $c = $buf[$i]
  if( ($c -ge 65 -and $c -le 90) -or ($c -ge 97 -and $c -le 122) -or ($c -ge 48 -and $c -le 57) -or $c -eq 95 ){
    [void]$cur.Append([char]$c)
  } else {
    if($cur.Length -ge 4){ $runs.Add([pscustomobject]@{Off=$i-$cur.Length; Txt=$cur.ToString()}) }
    $cur.Clear() | Out-Null
  }
}
Say "----- Chaines >=4 car. dans l'en-tete de ACTES_2.fic -----"
foreach($r in $runs){ Say ("  off {0,6} : {1}" -f $r.Off, $r.Txt) }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
