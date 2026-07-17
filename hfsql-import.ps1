# Lit l'enregistrement cree par l'import (patient 1499, date 20260716) dans la photo APRES,
# en pointant RepFic sur le dossier "after". Dump tous les champs non vides.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-import.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$after = "$env:USERPROFILE\Desktop\pec-express-connect\after"
$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;RepFic=$after;"
Say "cs = $cs"
try { $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK (photo APRES)" }
catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])"; $L | Out-File $out -Encoding UTF8; exit }

function Dump($sql){
  try{
    $cmd=$conn.CreateCommand(); $cmd.CommandText=$sql; $r=$cmd.ExecuteReader(); $n=0
    while($r.Read()){ $n++; Say "========== enregistrement $n =========="
      for($i=0;$i -lt $r.FieldCount;$i++){ if(-not $r.IsDBNull($i)){ $v=[string]$r.GetValue($i); if($v.Trim() -ne ''){ if($v.Length -gt 300){$v=$v.Substring(0,300)+'…'}; Say ("  {0} = {1}" -f $r.GetName($i),$v) } } }
    }
    $r.Close(); return $n
  } catch { Say "KO: $($_.Exception.Message.Split([char]10)[0])"; return -1 }
}

Say "=== Import du 16/07/2026 sur patient 1499 ==="
$n = Dump "SELECT * FROM ACTES_2 WHERE NUMERO=1499 AND DATE='20260716'"
if($n -le 0){
  Say "=== secours: tous les actes 1499 (les plus recents en dernier) ==="
  Dump "SELECT * FROM ACTES_2 WHERE NUMERO=1499"
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
