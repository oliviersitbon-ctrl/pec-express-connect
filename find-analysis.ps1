# Cherche TOUTES les analyses .wdd du systeme et teste laquelle ouvre ACTES_2
# avec le champ memo (>60 colonnes). Lecture seule (connexion + lecture schema).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_find-analysis.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Lister les .wdd candidats
$roots = @("C:\wlogos1","L:\","\\PANO\wlogos2","C:\My Projects","C:\Program Files\PC SOFT","C:\ProgramData")
$wdds = New-Object System.Collections.Generic.List[string]
foreach($r in $roots){
  if(Test-Path $r){
    try {
      Get-ChildItem $r -Filter *.wdd -Recurse -ErrorAction SilentlyContinue -Depth 4 |
        ForEach-Object { $wdds.Add($_.FullName) }
    } catch {}
  }
}
$wdds = $wdds | Sort-Object -Unique
Say "Analyses .wdd trouvees : $($wdds.Count)"
foreach($w in $wdds){ try { Say ("  {0,8} o  {1}" -f (Get-Item $w).Length, $w) } catch {} }

# 2) Tester chacune : ouvre-t-elle ACTES_2 ? combien de colonnes ? memo ?
Say ""
Say "===== Test ODBC de chaque analyse sur ACTES_2 ====="
foreach($w in $wdds){
  $cs = "DSN=LOGOSCOPY;Analyse=$w;"
  try {
    $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open()
    try {
      $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $rd=$c.ExecuteReader()
      $cols=@(); for($i=0;$i -lt $rd.FieldCount;$i++){ $cols += $rd.GetName($i) }
      $rd.Close()
      $memo = $cols | Where-Object { $_ -match 'MEMO|REMARQUE|COMMENT|DOCUMENT|MATERIAU|TEXTE|NOTE' }
      Say ("  [OK ACTES_2 : $($cols.Count) colonnes] $w")
      if($cols.Count -gt 60){ Say ("     >>> PLUS DE 60 COLONNES ! derniers: " + (($cols[-4..-1]) -join ', ')) }
      if($memo){ Say ("     >>> colonnes memo possibles: " + ($memo -join ', ')) }
    } catch {
      Say ("  [ouvre pas ACTES_2] $w  -> $($_.Exception.Message.Split([char]10)[0])")
    }
    $conn.Close()
  } catch {
    Say ("  [connexion KO] $w  -> $($_.Exception.Message.Split([char]10)[0])")
  }
}

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
