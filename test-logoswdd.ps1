# Test cible : WinDev doit etre ferme. Rafraichit la copie, puis teste ANA00001
# (reference 60 col) et LOGOSWS1.WDD (analyse Logos, 61 champs ?). Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_test-logoswdd.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$all = Get-Process -ErrorAction SilentlyContinue
$wdev = $all | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
Say ("WinDev: " + $(if($wdev){($wdev.ProcessName|Select -Unique) -join ','}else{'aucun (bien)'}))
Say ("Logos : " + $(if(($all|?{$_.ProcessName -match 'logos'})){'ouvert'}else{'ferme'}))
if($wdev){ Say "!!! WinDev encore ouvert -> ferme-le (verifie dans le gestionnaire des taches) et relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }

# Rafraichir la copie
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie rafraichie." } catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

function TestW($label,$wdd){
  Say ""; Say "=== $label ==="; Say "  $wdd"
  try {
    $conn=New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY;Analyse=$wdd;"); $conn.Open()
    try {
      $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $rd=$c.ExecuteReader()
      $cols=@(); for($i=0;$i -lt $rd.FieldCount;$i++){ $cols+=$rd.GetName($i) }; $rd.Close()
      Say ("  OUVRE ACTES_2 : $($cols.Count) colonnes")
      if($cols.Count -gt 60){ Say ("  >>> MEMO PRESENT ! colonnes en plus: " + (($cols[60..($cols.Count-1)]) -join ', ')) }
    } catch { Say ("  ouvre pas ACTES_2 -> $($_.Exception.Message.Split([char]10)[0])") }
    $conn.Close()
  } catch { Say ("  connexion KO -> $($_.Exception.Message.Split([char]10)[0])") }
}

TestW "ANA00001 (reference)" "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd"
TestW "LOGOSWS1.WDD (Logos)" "C:\wlogos1\LOGOSWS1.WDD"

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
