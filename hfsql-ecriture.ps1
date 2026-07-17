# Trouve et affiche EN ENTIER de vrais actes "Enregistrement du devis PDF".
# Cherche par NOMACTE, et en secours dump les actes du patient 1720.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-ecriture.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
$conn = New-Object System.Data.Odbc.OdbcConnection($cs)
$conn.Open(); Say "Connexion OK"

function DumpQuery($sql,$max){
  try {
    $cmd=$conn.CreateCommand(); $cmd.CommandText=$sql; $r=$cmd.ExecuteReader(); $n=0
    while($r.Read() -and $n -lt $max){ $n++; Say "===== ligne $n ====="; for($i=0;$i -lt $r.FieldCount;$i++){ $v= if($r.IsDBNull($i)){'<null>'}else{[string]$r.GetValue($i)}; if($v -ne '' -and $v -ne '<null>'){ Say ("  {0} = {1}" -f $r.GetName($i),$v) } } }
    $r.Close(); return $n
  } catch { Say "KO ($sql): $($_.Exception.Message.Split([char]10)[0])"; return -1 }
}

Say "=== A) actes NOMACTE LIKE 'Enregistrement du devis PDF' ==="
$n = DumpQuery "SELECT TOP 3 * FROM ACTES_2 WHERE NOMACTE LIKE '%Enregistrement du devis PDF%'" 3

if($n -le 0){
  Say "=== B) actes NOMACTE LIKE 'devis PDF' ==="
  $n = DumpQuery "SELECT TOP 3 * FROM ACTES_2 WHERE NOMACTE LIKE '%devis PDF%'" 3
}
if($n -le 0){
  Say "=== C) actes du patient NUMERO=1720 (pour voir les libelles) ==="
  DumpQuery "SELECT TOP 15 NUMERO, DATE, HEURE, CODEACTE, NOMACTE, TYPE, DEVIS_CLEUNIK FROM ACTES_2 WHERE NUMERO = 1720" 15
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
