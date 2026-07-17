# === TEST v3 === LOGOS *et* WINDEV doivent etre FERMES pendant la copie.
# But : obtenir enfin une copie "propre" (sans drapeau fichier-ouvert) et lire ACTES_2.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_test-v3.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$all = Get-Process -ErrorAction SilentlyContinue
$wdev  = $all | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
$logos = $all | Where-Object { $_.ProcessName -match 'logos' }
Say "----- Processus -----"
Say ("  WINDEV: " + $(if($wdev){($wdev.ProcessName|Select -Unique) -join ','}else{'aucun (bien)'}))
Say ("  LOGOS : " + $(if($logos){($logos.ProcessName|Select -Unique) -join ','}else{'aucun (bien)'}))
if($wdev -or $logos){ Say ""; Say "!!! Ferme LES DEUX (Logos ET WinDev) puis relance. Il faut qu'ils soient fermes PENDANT la copie. !!!"; $L | Out-File $out -Encoding UTF8; exit }

# Copie propre (rien n'ouvre le fichier)
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie propre faite (tout ferme)." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

# En-tete du .fic copie (100 premiers octets, en hexa) pour inspecter le drapeau
try {
  $fic = "$env:USERPROFILE\Desktop\Patients\ACTES_2.fic"
  $bytes = [System.IO.File]::ReadAllBytes($fic)[0..99]
  $hex = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ' '
  Say "----- En-tete ACTES_2.fic (100 octets) -----"; Say "  $hex"
} catch { Say "Lecture en-tete KO: $($_.Exception.Message.Split([char]10)[0])" }

function Test-Analyse($label, $wdd, $withMemo){
  Say ""; Say "========== $label =========="
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
Test-Analyse "A) ANA00001 (propre, SANS memo)" "C:\My Projects\My_Project\My_Project.ana\ANA00001\My_Project.wdd" $false
Test-Analyse "B) Actuelle (AVEC memo)"        "C:\My Projects\My_Project\My_Project.wdd"                      $true

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
