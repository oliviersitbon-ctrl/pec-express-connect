# TOUT-EN-UN (lecture seule, copie via DSN LOGOSCOPY) :
#  1) liste des tables vues par le pilote
#  2) trouve le bon nom pour ACTES_2 (et DEVIS, CIVIL)
#  3) colonnes + types de la table actes
#  4) repere la colonne memo
#  5) dumpe 3 vrais actes "Enregistrement du devis PDF" en entier
#  6) cherche l'analyse .WDD dans C:\wlogos1 et la copie
# NE MODIFIE RIEN.

$ErrorActionPreference = 'Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-all.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY")
try { $conn.Open(); Say "Connexion OK (DSN=LOGOSCOPY)" }
catch { Say "Connexion KO: $($_.Exception.Message)"; $L | Out-File $out -Encoding UTF8; exit }

# 1) Tables exposees
$tableNames = @()
try {
  $t = $conn.GetSchema('Tables')
  Say "=== Tables exposees par le pilote: $($t.Rows.Count) ==="
  foreach ($r in $t.Rows) { $nm = [string]$r['TABLE_NAME']; $tableNames += $nm; Say ("  '{0}'  (type={1})" -f $nm, $r['TABLE_TYPE']) }
} catch { Say "GetSchema('Tables') KO: $($_.Exception.Message)" }

# 2) Trouver le bon nom pour la table des actes
function Test-Table($nm) {
  try { $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM $nm"; $r=$c.ExecuteReader(); $fc=$r.FieldCount; $r.Close(); return $fc }
  catch { return -1 }
}
$candidates = @()
$candidates += ($tableNames | Where-Object { $_ -match 'ACTES' })
$candidates += @('ACTES_2','ACTES2','[ACTES_2]','"ACTES_2"','ACTES_2.fic','Actes_2')
$actName = $null
foreach ($nm in ($candidates | Select-Object -Unique)) {
  $fc = Test-Table $nm
  if ($fc -ge 0) { Say "OK table actes = '$nm' ($fc colonnes)"; $actName = $nm; break }
  else { Say "  (KO nom '$nm')" }
}

if ($actName) {
  # 3) colonnes + types
  try {
    $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM $actName"; $r=$c.ExecuteReader()
    $cols=@()
    for($i=0;$i -lt $r.FieldCount;$i++){ $cols += [pscustomobject]@{i=$i;name=$r.GetName($i);type=$r.GetFieldType($i).Name} }
    $r.Close()
    Say "=== COLONNES de $actName ($($cols.Count)) ==="
    foreach($cc in $cols){ Say ("  [{0}] {1} ({2})" -f $cc.i,$cc.name,$cc.type) }
  } catch { Say "colonnes KO: $($_.Exception.Message)" }

  # 4) reperer la colonne memo (contient <X> / Remarque)
  $memoCol=$null
  try {
    $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 300 * FROM $actName"; $r=$c.ExecuteReader()
    $hits=@{}
    while($r.Read()){ for($i=0;$i -lt $r.FieldCount;$i++){ if(-not $r.IsDBNull($i)){ $v=[string]$r.GetValue($i); if($v -match '<X>|<Remarque>|</Remarque>'){ $hits[$i]=[int]$hits[$i]+1 } } } }
    $r.Close()
    if($hits.Count){ $b=($hits.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 1); $memoCol=$r.GetName([int]$b.Key)
      # GetName apres Close ne marche pas -> retrouver via cols
      $memoCol=($cols|Where-Object{$_.i -eq [int]$b.Key}).name
      Say "Colonne memo = '$memoCol' ($($b.Value)/300)" }
    else { Say "colonne memo non detectee sur 300 lignes" }
  } catch { Say "detection memo KO: $($_.Exception.Message)" }

  # 5) dump 3 actes 'Enregistrement du devis PDF'
  if($memoCol){
    foreach($q in @("SELECT TOP 3 * FROM $actName WHERE [$memoCol] LIKE '%Enregistrement du devis PDF%'",
                    "SELECT TOP 3 * FROM $actName WHERE $memoCol LIKE '%Enregistrement du devis PDF%'")){
      try{
        $c=$conn.CreateCommand(); $c.CommandText=$q; $r=$c.ExecuteReader(); $n=0
        while($r.Read()){ $n++; Say "==================== ACTE $n ===================="
          for($i=0;$i -lt $r.FieldCount;$i++){ $v= if($r.IsDBNull($i)){'<null>'}else{[string]$r.GetValue($i)}; Say ("  {0} = {1}" -f $r.GetName($i),$v) } }
        $r.Close()
        if($n -gt 0){ break } else { Say "0 resultat pour: $q" }
      } catch { Say "requete KO ($q): $($_.Exception.Message.Split([char]10)[0])" }
    }
  }
} else { Say "Impossible de trouver la table des actes." }

$conn.Close()

# 6) chercher l'analyse .WDD
Say "=== recherche analyse .WDD ==="
foreach($root in @('C:\wlogos1','C:\wlogos1\*', "$env:USERPROFILE\Desktop\Patients")){
  Get-ChildItem -Path $root -Filter '*.wdd' -Recurse -Depth 2 -ErrorAction SilentlyContinue | Select-Object -First 10 | ForEach-Object { Say ("  WDD: " + $_.FullName + "  (" + $_.Length + " o)") }
}
Get-ChildItem -Path 'C:\wlogos1' -Filter '*.wd*' -ErrorAction SilentlyContinue | Select-Object -First 20 | ForEach-Object { Say ("  wlogos1: " + $_.Name) }

$L | Out-File $out -Encoding UTF8
Write-Host ""
Write-Host "TOUT est dans: $out"
