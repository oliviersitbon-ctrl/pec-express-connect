# === TEST v2 === WINDEV doit etre FERME (il verrouille la copie ACTES_2 qu'il a importee).
# Logos peut rester ouvert. Recopie fraiche, puis teste les deux analyses.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_test-v2.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 0) Lister tout processus WinDev / Logos
$all = Get-Process -ErrorAction SilentlyContinue
$wdev  = $all | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
$logos = $all | Where-Object { $_.ProcessName -match 'logos' }
Say "----- Processus detectes -----"
if($wdev){ $wdev | Select-Object ProcessName,Id -Unique | ForEach-Object { Say ("  WINDEV: {0} (PID {1})" -f $_.ProcessName,$_.Id) } } else { Say "  WINDEV: aucun (bien)" }
if($logos){ $logos | Select-Object ProcessName,Id -Unique | ForEach-Object { Say ("  LOGOS : {0} (PID {1})" -f $_.ProcessName,$_.Id) } } else { Say "  LOGOS : aucun" }
if($wdev){ Say ""; Say "!!! WINDEV EST ENCORE OUVERT. Ferme-le entierement (toutes ses fenetres) et relance. !!!"; $L | Out-File $out -Encoding UTF8; exit }

# 1) Recopie fraiche
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie prod -> Desktop\Patients faite." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

function Test-Analyse($label, $wdd, $withMemo){
  Say ""; Say "========== $label =========="; Say "  wdd = $wdd (existe=$(Test-Path $wdd))"
  try {
    $conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY;Analyse=$wdd;"); $conn.Open()
    $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar()
    Say "  COUNT(*) = $n  ==> LECTURE OK"
    if($withMemo){
      $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 40 ACTE_CLE_UNIQUE, NUMERO, COMMENTAIRE FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"
      $rd=$c.ExecuteReader(); $found=0
      while($rd.Read()){ $m = if($rd.IsDBNull(2)){''}else{[string]$rd.GetValue(2)}; if($m.Trim().Length -gt 0){ $found++; Say ("  MEMO cle=$($rd[0]) num=$($rd[1]) : [$m]") } }
      $rd.Close()
      if($found -eq 0){ Say "  (aucun memo non vide dans les 40 dernieres)" } else { Say "  ==> $found memo(s) lus." }
    }
    $conn.Close()
  } catch { Say "  KO: $($_.Exception.Message.Split([char]10)[0])" }
}

Test-Analyse "A) ANA00001 (propre, 60 champs, SANS memo)" "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd" $false
Test-Analyse "B) Actuelle (AVEC memo COMMENTAIRE)"        "C:\My Projects\My_Project\My_Project.wdd"                      $true

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
