# Force la nouvelle analyse v28 directement dans la chaine de connexion (sans passer
# par le DSN, pour eviter le probleme de droits admin). Teste plusieurs variantes,
# puis lit les colonnes de ACTES_2 et 2 ecritures. Lecture seule sur la copie.

$ErrorActionPreference = 'Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-analyse.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$paths = @(
  'C:\My Projects\My_Project\My_Project.wdd',
  'C:\My Projects\My_Project\My_Project.ana\My_Project.wdd',
  'C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd'
)
$kw = @('Analyse','Analysis')

$conn=$null; $used=$null
foreach($p in $paths){
  foreach($k in $kw){
    $cs = "DSN=LOGOSCOPY;$k=$p;"
    try {
      $c = New-Object System.Data.Odbc.OdbcConnection($cs)
      $c.Open()
      # test rapide
      $cmd=$c.CreateCommand(); $cmd.CommandText="SELECT TOP 1 * FROM ACTES_2"; $r=$cmd.ExecuteReader(); $fc=$r.FieldCount; $r.Close()
      $conn=$c; $used=$cs
      Say "OK avec: $cs  ($fc colonnes)"
      break
    } catch {
      Say "KO: $cs"
      Say "   -> $($_.Exception.Message.Split([char]10)[0])"
      if($c){ try{$c.Close()}catch{} }
    }
  }
  if($conn){ break }
}

if(-not $conn){ Say "Aucune variante n'a fonctionne."; $L | Out-File $out -Encoding UTF8; exit }

# Colonnes de ACTES_2
$cols=@()
$cmd=$conn.CreateCommand(); $cmd.CommandText="SELECT TOP 1 * FROM ACTES_2"; $r=$cmd.ExecuteReader()
for($i=0;$i -lt $r.FieldCount;$i++){ $cols += [pscustomobject]@{i=$i;name=$r.GetName($i);type=$r.GetFieldType($i).Name} }
$r.Close()
Say "=== COLONNES ACTES_2 ($($cols.Count)) ==="
foreach($cc in $cols){ Say ("  [{0}] {1} ({2})" -f $cc.i,$cc.name,$cc.type) }

# Colonne memo
$memoCol=$null
$cmd=$conn.CreateCommand(); $cmd.CommandText="SELECT TOP 300 * FROM ACTES_2"; $r=$cmd.ExecuteReader()
$hits=@{}
while($r.Read()){ for($i=0;$i -lt $r.FieldCount;$i++){ if(-not $r.IsDBNull($i)){ $v=[string]$r.GetValue($i); if($v -match '<X>|<Remarque>'){ $hits[$i]=[int]$hits[$i]+1 } } } }
$r.Close()
if($hits.Count){ $b=($hits.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 1); $memoCol=($cols|Where-Object{$_.i -eq [int]$b.Key}).name; Say "Colonne memo = '$memoCol'" }

# 2 ecritures completes
if($memoCol){
  $cmd=$conn.CreateCommand(); $cmd.CommandText="SELECT TOP 2 * FROM ACTES_2 WHERE [$memoCol] LIKE '%Enregistrement du devis PDF%'"; $r=$cmd.ExecuteReader(); $n=0
  while($r.Read()){ $n++; Say "===== ACTE $n ====="; for($i=0;$i -lt $r.FieldCount;$i++){ $v= if($r.IsDBNull($i)){'<null>'}else{[string]$r.GetValue($i)}; Say ("  {0} = {1}" -f $r.GetName($i),$v) } }
  $r.Close()
  if($n -eq 0){ Say "0 ecriture trouvee via LIKE." }
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
