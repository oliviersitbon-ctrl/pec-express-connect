# Dump COMPLET (tous champs non vides) des actes lies a un devis, pour localiser
# le libelle "Enregistrement du devis PDF" et le lien PDF.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-full.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
$conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK"

function Dump($sql,$max){
  try{
    $cmd=$conn.CreateCommand(); $cmd.CommandText=$sql; $r=$cmd.ExecuteReader(); $n=0
    while($r.Read() -and $n -lt $max){ $n++; Say "========== ligne $n =========="
      for($i=0;$i -lt $r.FieldCount;$i++){ if(-not $r.IsDBNull($i)){ $v=[string]$r.GetValue($i); if($v.Trim() -ne ''){ if($v.Length -gt 200){$v=$v.Substring(0,200)+'…'}; Say ("  {0} = {1}" -f $r.GetName($i),$v) } } }
    }
    $r.Close(); return $n
  } catch { Say "KO: $($_.Exception.Message.Split([char]10)[0])"; return -1 }
}

Say "=== A) patient 1720, actes lies a un devis (1097/1099) ==="
Dump "SELECT * FROM ACTES_2 WHERE NUMERO=1720 AND (DEVIS_CLEUNIK=1097 OR DEVIS_CLEUNIK=1099)" 4

Say ""
Say "=== B) 5 actes lies a un devis d'AUTRES patients (ecritures completes) ==="
Dump "SELECT TOP 5 * FROM ACTES_2 WHERE DEVIS_CLEUNIK <> 0 AND NUMERO <> 1720" 5

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
