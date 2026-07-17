# Diagnostic complet (WINDEV doit etre ferme). Restaure ANA00001 au bon endroit,
# dumpe le DSN, liste les tables vues, teste ACTES_2 + une autre table.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_fix-diag.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$all = Get-Process -ErrorAction SilentlyContinue
$wdev = $all | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
if($wdev){ Say "!!! WINDEV encore ouvert ($(($wdev.ProcessName|Select -Unique) -join ',')). Ferme-le et relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Say "WinDev ferme : OK"

# 1) Restaurer ANA00001 -> emplacement principal
$main="C:\My Projects\My_Project"; $ana1="$main\My_Project.ana\ANA00001"
try {
  Copy-Item "$ana1\My_Project.wdd" "$main\My_Project.wdd" -Force
  Copy-Item "$ana1\My_Project.wda" "$main\My_Project.wda" -Force
  Say "ANA00001 restauree. My_Project.wdd = $((Get-Item "$main\My_Project.wdd").Length) o (attendu 7142)."
} catch { Say "Restauration KO: $($_.Exception.Message.Split([char]10)[0])" }

# 2) Rafraichir la copie
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie ACTES_2 faite." } catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

# 3) Dump du DSN LOGOSCOPY dans le registre
Say "----- Config DSN LOGOSCOPY (registre) -----"
$paths = @(
  "HKLM:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY",
  "HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBC.INI\LOGOSCOPY",
  "HKCU:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY"
)
foreach($p in $paths){
  if(Test-Path $p){
    Say "  [$p]"
    (Get-ItemProperty $p).PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Say ("     {0} = {1}" -f $_.Name, $_.Value) }
  }
}

# 4) Connexion + liste des tables + test ACTES_2 et une autre table
$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
Say "----- Connexion + tables -----"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK"
  try {
    $t = $conn.GetSchema("Tables")
    $names = @(); foreach($row in $t.Rows){ $names += [string]$row["TABLE_NAME"] }
    Say ("  Tables vues ("+$names.Count+"): " + (($names | Select-Object -First 30) -join ', '))
  } catch { Say "  GetSchema KO: $($_.Exception.Message.Split([char]10)[0])" }

  foreach($tbl in @('ACTES_2','DEVIS','PATIENTS','DOCUMENT')){
    try {
      $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM $tbl"; $n=[int]$c.ExecuteScalar()
      Say "  $tbl : COUNT = $n  (OK)"
    } catch { Say "  $tbl : KO -> $($_.Exception.Message.Split([char]10)[0])" }
  }
  $conn.Close()
} catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
