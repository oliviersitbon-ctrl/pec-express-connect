# Restaure une analyse qui FONCTIONNE en pointant l'ODBC sur la version d'origine
# conservee par WinDev (ANA00001, 7142 o, 60 champs, alignee sur le fichier physique).
# On ne touche a rien dans WinDev. Test de lecture sur la COPIE.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_restore-test.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Rafraichir la copie depuis la prod
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie prod -> Desktop\Patients faite." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

$wdd = "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd"
Say "Analyse utilisee: $wdd (existe=$(Test-Path $wdd))"

$cs = "DSN=LOGOSCOPY;Analyse=$wdd;"
try { $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK (copie)" }
catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])"; $L | Out-File $out -Encoding UTF8; exit }

# 2) Lire les 3 dernieres ecritures pour confirmer que la table s'ouvre de nouveau
try {
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 3 ACTE_CLE_UNIQUE, NUMERO, DATE, HEURE, NOMACTE, CODEACTE, TYPE, DEVIS_CLEUNIK FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"
  $rd=$c.ExecuteReader(); $n=0
  while($rd.Read()){ $n++
    Say ("  cle=$($rd[0]) num=$($rd[1]) date=$($rd[2]) heure=$($rd[3]) nomacte=[$($rd[4])] code=[$($rd[5])] type=[$($rd[6])] devis=$($rd[7])")
  }
  $rd.Close()
  if($n -gt 0){ Say "==> OK : l'analyse ANA00001 lit de nouveau ACTES_2 ($n lignes)." }
  else { Say "==> 0 ligne lue." }
} catch { Say "Requete KO: $($_.Exception.Message.Split([char]10)[0])" }

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
