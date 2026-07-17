# Diagnostic : pourquoi "Impossible d'acceder au fichier" ?
# Verrou (Logos/WinDev ouvert) ? Copie incoherente ? Structure ?
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_diag-lock.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Processus qui pourraient verrouiller la base
Say "----- Processus Logos / WinDev / HFSQL en cours -----"
Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match 'logos|wlogos|windev|wd2|hf|manta|cabflow' } |
  ForEach-Object { Say ("  {0}  (PID {1})" -f $_.ProcessName, $_.Id) }

# 2) Etat des fichiers de la copie
Say "----- Desktop\Patients\ACTES_2.* -----"
Get-ChildItem "$env:USERPROFILE\Desktop\Patients\ACTES_2.*" -ErrorAction SilentlyContinue |
  ForEach-Object { Say ("  {0,-20} {1,10} o  {2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString('HH:mm:ss')) }

# 3) Etat des fichiers de prod (source de la copie)
Say "----- L:\Patients\ACTES_2.* (prod) -----"
Get-ChildItem "L:\Patients\ACTES_2.*" -ErrorAction SilentlyContinue |
  ForEach-Object { Say ("  {0,-20} {1,10} o  {2}" -f $_.Name, $_.Length, $_.LastWriteTime.ToString('HH:mm:ss')) }

# 4) Test COUNT(*) minimal avec ANA00001 (sans ORDER BY, sans colonnes exotiques)
$wdd = "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd"
$cs = "DSN=LOGOSCOPY;Analyse=$wdd;"
Say "----- Test COUNT(*) avec ANA00001 -----"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open()
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar()
  Say "  OK : $n enregistrements"
  $conn.Close()
} catch { Say "  KO: $($_.Exception.Message.Split([char]10)[0])" }

# 5) Test avec le .wdd top-level (celui qui marchait avant)
$wdd2 = "C:\My Projects\My_Project\My_Project.wdd"
Say "----- Test COUNT(*) avec My_Project.wdd (top-level) -----"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY;Analyse=$wdd2;"); $conn.Open()
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar()
  Say "  OK : $n enregistrements"
  $conn.Close()
} catch { Say "  KO: $($_.Exception.Message.Split([char]10)[0])" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
