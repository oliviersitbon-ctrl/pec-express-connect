# Diagnostic precis : config reelle du DSN + erreur exacte du SELECT + collections de schema.
$ErrorActionPreference = 'Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-diag.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Config reelle du DSN dans le registre (64 bits)
Say "=== Config DSN LOGOSCOPY (registre) ==="
foreach($k in @('HKLM:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY','HKCU:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY')){
  $p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
  if($p){ Say "  [$k]"; $p.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Say ("     {0} = {1}" -f $_.Name, $_.Value) } }
}

# 2) Connexion + erreur exacte
$conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY")
try { $conn.Open(); Say "Connexion OK" } catch { Say "Connexion KO: $($_.Exception.Message)"; $L | Out-File $out -Encoding UTF8; exit }

Say "=== SELECT TOP 1 * FROM ACTES_2 -> erreur complete ==="
try { $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $r=$c.ExecuteReader(); Say ("OK ! " + $r.FieldCount + " colonnes"); $r.Close() }
catch { Say ($_.Exception.Message) }

# 3) Collections de schema disponibles + tables + une requete sur une table simple
Say "=== GetSchema() collections ==="
try { $s=$conn.GetSchema(); foreach($r in $s.Rows){ Say ("   " + $r[0]) } } catch { Say "GetSchema() KO: $($_.Exception.Message)" }

Say "=== GetSchema('Tables') detail ==="
try { $t=$conn.GetSchema('Tables'); Say ("   lignes: " + $t.Rows.Count); foreach($r in ($t.Rows | Select-Object -First 30)){ Say ("   -> " + ($r.ItemArray -join ' | ')) } } catch { Say "KO: $($_.Exception.Message)" }

# 4) essais directs sur quelques tables connues de Logos
foreach($nm in @('ACTES_2','DEVIS','CIVIL','ACTES','RendezVous')){
  try { $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM $nm"; $r=$c.ExecuteReader(); Say ("OK '$nm' -> $($r.FieldCount) colonnes"); $r.Close() }
  catch { Say ("KO '$nm' -> " + $_.Exception.Message.Split([char]10)[0]) }
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
