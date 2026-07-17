# Lecture seule via DSN LOGOSCOPY (copie de la base).
# 1) colonnes de ACTES_2 ; 2) reperage de la colonne memo ; 3) dump complet
#    de 3 actes "Enregistrement du devis PDF". NE MODIFIE RIEN.

$ErrorActionPreference = 'Stop'
$out = "$env:USERPROFILE\Desktop\_hfsql-acte.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY")
try { $conn.Open(); Say "Connexion OK (DSN=LOGOSCOPY)" }
catch { Say "Connexion KO: $($_.Exception.Message)"; $L | Out-File $out -Encoding UTF8; exit }

# 1) Colonnes + types
$cols = @()
try {
  $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT TOP 1 * FROM ACTES_2"
  $rdr = $cmd.ExecuteReader()
  for ($i=0; $i -lt $rdr.FieldCount; $i++) { $cols += [pscustomobject]@{ i=$i; name=$rdr.GetName($i); type=$rdr.GetFieldType($i).Name } }
  $rdr.Close()
  Say "=== COLONNES ACTES_2 ($($cols.Count)) ==="
  foreach ($c in $cols) { Say ("  [{0}] {1}  ({2})" -f $c.i, $c.name, $c.type) }
} catch { Say "Lecture colonnes KO: $($_.Exception.Message)"; $conn.Close(); $L | Out-File $out -Encoding UTF8; exit }

# 2) Reperer la colonne memo : scanner 200 lignes, trouver la colonne contenant '<X>' ou 'Remarque'
$memoCol = $null
try {
  $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT TOP 200 * FROM ACTES_2"
  $rdr = $cmd.ExecuteReader()
  $hits = @{}
  while ($rdr.Read()) {
    for ($i=0; $i -lt $rdr.FieldCount; $i++) {
      if (-not $rdr.IsDBNull($i)) {
        $v = [string]$rdr.GetValue($i)
        if ($v -match '<X>|</Remarque>|<Remarque>') { $hits[$i] = ($hits[$i] + 1) }
      }
    }
  }
  $rdr.Close()
  if ($hits.Count -gt 0) {
    $best = ($hits.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1)
    $memoCol = ($cols | Where-Object { $_.i -eq [int]$best.Key }).name
    Say ("Colonne memo detectee: '$memoCol' (i=$($best.Key), $($best.Value) hits sur 200)")
  } else { Say "Aucune colonne memo detectee dans les 200 premieres lignes." }
} catch { Say "Detection memo KO: $($_.Exception.Message)" }

# 3) Dump complet de 3 actes "Enregistrement du devis PDF"
if ($memoCol) {
  try {
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT TOP 3 * FROM ACTES_2 WHERE [$memoCol] LIKE '%Enregistrement du devis PDF%'"
    $rdr = $cmd.ExecuteReader()
    $n = 0
    while ($rdr.Read()) {
      $n++
      Say "==================== ACTE $n (complet) ===================="
      for ($i=0; $i -lt $rdr.FieldCount; $i++) {
        $v = if ($rdr.IsDBNull($i)) { '<null>' } else { [string]$rdr.GetValue($i) }
        Say ("  {0} = {1}" -f $rdr.GetName($i), $v)
      }
    }
    $rdr.Close()
    if ($n -eq 0) { Say "Aucun acte 'Enregistrement du devis PDF' trouve via LIKE." }
  } catch { Say "Requete filtree KO: $($_.Exception.Message)" }
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host ""
Write-Host "Resultat aussi ecrit dans: $out"
