# Rafraichit les donnees lues par le DSN avec la production actuelle, puis affiche
# les tout derniers enregistrements de ACTES_2 (l'import est dedans) avec TOUS les champs.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_hfsql-newest.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Rafraichir la copie lue par le DSN (Desktop\Patients) avec la prod (L:\Patients)
Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force
Say "Copie prod -> Desktop\Patients faite."

$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
try { $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK" }
catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])"; $L | Out-File $out -Encoding UTF8; exit }

try {
  $cmd=$conn.CreateCommand(); $cmd.CommandText="SELECT TOP 4 * FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"; $r=$cmd.ExecuteReader(); $n=0
  while($r.Read()){ $n++; Say "========== enregistrement $n (le plus recent en premier) =========="
    for($i=0;$i -lt $r.FieldCount;$i++){ $v= if($r.IsDBNull($i)){'<vide>'}else{[string]$r.GetValue($i)}; if($v.Length -gt 300){$v=$v.Substring(0,300)+'…'}; Say ("  {0} = {1}" -f $r.GetName($i),$v) }
  }
  $r.Close()
} catch { Say "Requete KO: $($_.Exception.Message.Split([char]10)[0])" }

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
