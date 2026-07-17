# Restaure la BONNE analyse (ANA00001, 7142 o) a l'emplacement principal, exactement
# la ou elle etait quand les lectures/INSERT marchaient. WinDev doit etre ferme
# (pour pouvoir ecraser le .wda). Logos peut rester ouvert.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_restore-good.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$all = Get-Process -ErrorAction SilentlyContinue
$wdev = $all | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
Say ("WINDEV: " + $(if($wdev){($wdev.ProcessName|Select -Unique) -join ','}else{'aucun (bien)'}))
Say ("LOGOS : " + $(if(($all|?{$_.ProcessName -match 'logos'})){'ouvert'}else{'ferme'}))
if($wdev){ Say "!!! Ferme WinDev pour pouvoir restaurer l'analyse, puis relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }

# 1) Sauver l'actuelle (cassee) au cas ou, puis restaurer ANA00001 -> principal
$main = "C:\My Projects\My_Project"
$ana1 = "C:\My Projects\My_Project\My_Project.ana\ANA00001"
try {
  Copy-Item "$main\My_Project.wdd" "$main\My_Project.wdd.broken" -Force -ErrorAction SilentlyContinue
  Copy-Item "$main\My_Project.wda" "$main\My_Project.wda.broken" -Force -ErrorAction SilentlyContinue
  Copy-Item "$ana1\My_Project.wdd" "$main\My_Project.wdd" -Force
  Copy-Item "$ana1\My_Project.wda" "$main\My_Project.wda" -Force
  $sz = (Get-Item "$main\My_Project.wdd").Length
  Say "Analyse restauree. My_Project.wdd = $sz octets (attendu 7142)."
} catch { Say "Restauration KO: $($_.Exception.Message.Split([char]10)[0])" }

# 2) Rafraichir la copie ACTES_2 (comme dans le script qui marchait)
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie ACTES_2 faite." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

# 3) Test EXACT comme avant : Analyse = My_Project.wdd (principal)
$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
Say "----- Test lecture (config d'origine) -----"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar()
  Say "  COUNT(*) = $n  ==> LECTURE OK, on est repartis !"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 2 ACTE_CLE_UNIQUE, NUMERO, DATE FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"; $rd=$c.ExecuteReader()
  while($rd.Read()){ Say ("  cle=$($rd[0]) num=$($rd[1]) date=$($rd[2])") }
  $rd.Close(); $conn.Close()
} catch { Say "  KO: $($_.Exception.Message.Split([char]10)[0])" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
