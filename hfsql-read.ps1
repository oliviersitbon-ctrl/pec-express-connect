# Lecture seule via ODBC HFSQL sur la COPIE de la base (Bureau\Patients).
# Essaie plusieurs chaines de connexion "HFSQL Classic", garde celle qui marche,
# liste les colonnes de ACTES_2 et affiche 5 lignes. NE MODIFIE RIEN.

$ErrorActionPreference = 'Stop'
$dir = "$env:USERPROFILE\Desktop\Patients"   # <-- la COPIE
$out = "$env:USERPROFILE\Desktop\_hfsql-read.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add($m); Write-Host $m }

Say "Dossier copie: $dir"
if (-not (Test-Path "$dir\ACTES_2.fic")) { Say "ACTES_2.fic introuvable dans la copie !"; $L | Out-File $out -Encoding UTF8; exit }

# Chaines de connexion candidates pour HFSQL Classic (dossier de fichiers)
$css = @(
  "Driver={HFSQL};Server Name=;Database=$dir;",
  "Driver={HFSQL};Database=$dir;",
  "Driver={HFSQL};Server Name=localhost;Database=$dir;",
  "Driver={HFSQL};Server Name=$dir;",
  "Driver={HFSQL};Data Source=$dir;",
  "Driver={HFSQL};Server Name=;Database=$dir;UID=;PWD=;",
  "Driver={HFSQL};Server Name=127.0.0.1;Database=$dir;Port=4900;UID=admin;PWD=;"
)

$conn = $null; $used = $null
foreach ($cs in $css) {
  try {
    $c = New-Object System.Data.Odbc.OdbcConnection($cs)
    $c.Open()
    $conn = $c; $used = $cs
    Say "CONNECTE avec: $cs"
    break
  } catch {
    Say "  echec: $cs"
    Say "     -> $($_.Exception.Message)"
  }
}
if (-not $conn) { Say "Aucune chaine de connexion n'a fonctionne."; $L | Out-File $out -Encoding UTF8; exit }

# Lister les tables (pour confirmer ACTES_2)
try {
  $tabs = $conn.GetSchema('Tables')
  $names = @()
  foreach ($r in $tabs.Rows) { $names += $r['TABLE_NAME'] }
  Say ("Tables (echantillon): " + (($names | Where-Object { $_ -match 'ACTES|DEVIS|CIVIL' }) -join ', '))
} catch { Say "GetSchema tables KO: $($_.Exception.Message)" }

# Colonnes + 5 lignes de ACTES_2
try {
  $cmd = $conn.CreateCommand()
  $cmd.CommandText = "SELECT TOP 5 * FROM ACTES_2"
  $rdr = $cmd.ExecuteReader()
  $cols = @()
  for ($i=0; $i -lt $rdr.FieldCount; $i++) { $cols += ("{0}:{1}" -f $rdr.GetName($i), $rdr.GetFieldType($i).Name) }
  Say "=== COLONNES de ACTES_2 ($($rdr.FieldCount)) ==="
  Say ($cols -join " | ")
  Say "=== 5 premieres lignes (valeurs tronquees a 60c) ==="
  $n=0
  while ($rdr.Read() -and $n -lt 5) {
    $n++
    $vals = @()
    for ($i=0; $i -lt $rdr.FieldCount; $i++) {
      $v = if ($rdr.IsDBNull($i)) { '<null>' } else { ($rdr.GetValue($i).ToString()) }
      if ($v.Length -gt 60) { $v = $v.Substring(0,60) + '…' }
      $vals += ("{0}={1}" -f $rdr.GetName($i), $v)
    }
    Say ("--- ligne $n ---")
    Say ($vals -join " | ")
  }
  $rdr.Close()
} catch { Say "Lecture ACTES_2 KO: $($_.Exception.Message)" }

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host ""
Write-Host "Resultat aussi ecrit dans: $out"
