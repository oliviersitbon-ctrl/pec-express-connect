# Test PROPRE : WINDEV doit etre FERME (il verrouille la copie ACTES_2 qu'il a importee).
# Logos peut rester ouvert (l'INSERT marchait deja avec Logos ouvert).
# On recopie une version fraiche, puis on teste les DEUX analyses :
# ANA00001 (60 champs, propre) et l'actuelle (avec le champ memo COMMENTAIRE).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_test-clean.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 0) Etat des processus (info)
$wdev = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
$logos = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'logos' }
Say ("WinDev en cours : " + $(if($wdev){ ($wdev.ProcessName | Select-Object -Unique) -join ',' } else { 'non' }))
Say ("Logos en cours  : " + $(if($logos){ ($logos.ProcessName | Select-Object -Unique) -join ',' } else { 'non' }))
if($wdev){ Say "!!! WINDEV EST ENCORE OUVERT. Ferme-le entierement et relance ce script. !!!"; $L | Out-File $out -Encoding UTF8; exit }
Say "OK : WinDev est ferme, on continue."

# 1) Recopier une version fraiche depuis la prod
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie prod -> Desktop\Patients faite." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

function Test-Analyse($label, $wdd, $withMemo){
  Say ""
  Say "========== $label =========="
  Say "  wdd = $wdd (existe=$(Test-Path $wdd))"
  try {
    $conn = New-Object System.Data.Odbc.OdbcConnection("DSN=LOGOSCOPY;Analyse=$wdd;"); $conn.Open()
    $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar()
    Say "  COUNT(*) = $n  ==> LECTURE OK"
    if($withMemo){
      $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 40 ACTE_CLE_UNIQUE, NUMERO, COMMENTAIRE FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"
      $rd=$c.ExecuteReader(); $found=0
      while($rd.Read()){
        $m = if($rd.IsDBNull(2)){''}else{[string]$rd.GetValue(2)}
        if($m.Trim().Length -gt 0){ $found++; Say ("  MEMO cle=$($rd[0]) num=$($rd[1]) : [$m]") }
      }
      $rd.Close()
      if($found -eq 0){ Say "  (aucun memo non vide dans les 40 dernieres)" }
      else { Say "  ==> $found memo(s) lus. Si le texte ressemble a <X><Remarque>...>, l'alignement du memo est BON." }
    }
    $conn.Close()
  } catch { Say "  KO: $($_.Exception.Message.Split([char]10)[0])" }
}

Test-Analyse "A) ANA00001 (propre, 60 champs, SANS memo)" "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd" $false
Test-Analyse "B) Actuelle (AVEC memo COMMENTAIRE)"        "C:\My Projects\My_Project\My_Project.wdd"                      $true

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
