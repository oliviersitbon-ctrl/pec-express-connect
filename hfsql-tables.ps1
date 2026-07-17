# Liste les tables exposees par le DSN LOGOSCOPY (pour connaitre le bon nom a utiliser).
$ErrorActionPreference = 'Stop'
$out = "$env:USERPROFILE\Desktop\_hfsql-tables.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY")
try { $conn.Open(); Say "Connexion OK" } catch { Say "Connexion KO: $($_.Exception.Message)"; $L | Out-File $out -Encoding UTF8; exit }

try {
  $t = $conn.GetSchema('Tables')
  Say "=== Tables exposees: $($t.Rows.Count) ==="
  foreach ($r in $t.Rows) {
    Say ("  cat='{0}' schema='{1}' name='{2}' type='{3}'" -f $r['TABLE_CATALOG'], $r['TABLE_SCHEMA'], $r['TABLE_NAME'], $r['TABLE_TYPE'])
  }
} catch { Say "GetSchema('Tables') KO: $($_.Exception.Message)" }

# essais de requete sur differentes ecritures du nom
foreach ($nm in @('ACTES_2','ACTES_2.fic','[ACTES_2]','"ACTES_2"','ACTES2','Actes_2')) {
  try {
    $cmd = $conn.CreateCommand(); $cmd.CommandText = "SELECT TOP 1 * FROM $nm"
    $rdr = $cmd.ExecuteReader(); $fc = $rdr.FieldCount; $rdr.Close()
    Say "OK requete sur: $nm  ($fc colonnes)"
  } catch { Say "KO requete sur $nm : $($_.Exception.Message.Split([char]10)[0])" }
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini -> $out"
