# Extrait les noms de rubriques embarques dans l'en-tete de ACTES_2.fic,
# en essayant ASCII ET UTF-16LE. Le champ memo (61e) devrait apparaitre. Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_fic-names.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$fic = "L:\Patients\ACTES_2.fic"
$fs=[System.IO.File]::OpenRead($fic); $buf=New-Object byte[] 9000; $null=$fs.Read($buf,0,9000); $fs.Close()

function IsIdentChar($c){ return ( ($c -ge 65 -and $c -le 90) -or ($c -ge 97 -and $c -le 122) -or ($c -ge 48 -and $c -le 57) -or $c -eq 95 ) }

# --- ASCII ---
Say "===== ASCII (>=3) ====="
$cur=New-Object System.Text.StringBuilder
for($i=0;$i -lt $buf.Length;$i++){
  if(IsIdentChar $buf[$i]){ [void]$cur.Append([char]$buf[$i]) }
  else { if($cur.Length -ge 3){ Say ("  @{0} {1}" -f ($i-$cur.Length),$cur.ToString()) }; $cur.Clear()|Out-Null }
}

# --- UTF-16LE (lettre, 0x00, lettre, 0x00 ...) ---
Say "===== UTF-16LE (>=3) ====="
$cur=New-Object System.Text.StringBuilder; $start=0
$i=0
while($i -lt $buf.Length-1){
  if((IsIdentChar $buf[$i]) -and $buf[$i+1] -eq 0){
    if($cur.Length -eq 0){ $start=$i }
    [void]$cur.Append([char]$buf[$i]); $i+=2
  } else {
    if($cur.Length -ge 3){ Say ("  @{0} {1}" -f $start,$cur.ToString()) }
    $cur.Clear()|Out-Null; $i++
  }
}
if($cur.Length -ge 3){ Say ("  @{0} {1}" -f $start,$cur.ToString()) }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
