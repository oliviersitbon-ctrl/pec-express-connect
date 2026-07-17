# Restaure ANA00001 -> emplacement principal (config prouvee), confirme la lecture,
# PUIS teste LOGOSWS1.WDD. WinDev doit etre ferme. Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_test-logoswdd2.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$wdev = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
if($wdev){ Say "!!! WinDev ouvert, ferme-le et relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Say "WinDev ferme : OK"

# Restaurer ANA00001 -> principal
$main="C:\My Projects\My_Project"; $ana1="$main\My_Project.ana\ANA00001"
Copy-Item "$ana1\My_Project.wdd" "$main\My_Project.wdd" -Force
Copy-Item "$ana1\My_Project.wda" "$main\My_Project.wda" -Force
Say "ANA00001 -> principal ($((Get-Item "$main\My_Project.wdd").Length) o)"
Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force
Say "Copie rafraichie."

function TestW($label,$wdd){
  Say ""; Say "=== $label ==="
  try {
    $conn=New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY;Analyse=$wdd;"); $conn.Open()
    try {
      $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $rd=$c.ExecuteReader()
      $cols=@(); for($i=0;$i -lt $rd.FieldCount;$i++){ $cols+=$rd.GetName($i) }; $rd.Close()
      Say ("  OUVRE ACTES_2 : $($cols.Count) colonnes")
      if($cols.Count -gt 60){ Say ("  >>> MEMO PRESENT ! en plus: " + (($cols[60..($cols.Count-1)]) -join ', ')) }
    } catch { Say ("  ouvre pas -> $($_.Exception.Message.Split([char]10)[0])") }
    $conn.Close()
  } catch { Say ("  connexion KO -> $($_.Exception.Message.Split([char]10)[0])") }
}

TestW "BASELINE ANA00001 (principal)" "C:\My Projects\My_Project\My_Project.wdd"
TestW "LOGOSWS1.WDD" "C:\wlogos1\LOGOSWS1.WDD"

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
