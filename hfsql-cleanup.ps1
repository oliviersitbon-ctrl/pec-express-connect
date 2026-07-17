# NETTOYAGE du test : supprime l'ecriture de test (cle 25963) et le PDF de test.
# LOGOS DOIT ETRE FERME. Si la suppression ODBC echoue, on restaure la sauvegarde.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_cleanup.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$logos = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'logos' }
if($logos){ Say "!!! FERME LOGOS d'abord, puis relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Say "Logos ferme : OK"

$cle = 25963
$cs = "DSN=LOGOSPROD;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion prod OK"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE ACTE_CLE_UNIQUE=$cle"; $ex=[int]$c.ExecuteScalar(); Say "Avant: la cle $cle existe = $ex"
  $c=$conn.CreateCommand(); $c.CommandText="DELETE FROM ACTES_2 WHERE ACTE_CLE_UNIQUE=$cle"; $r=$c.ExecuteNonQuery(); Say "DELETE execute (lignes=$r)"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE ACTE_CLE_UNIQUE=$cle"; $ap=[int]$c.ExecuteScalar(); Say "Apres: la cle $cle existe = $ap"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE NUMERO=1720"; $n=[int]$c.ExecuteScalar(); Say "Total actes 1720 = $n (attendu 23)"
  if($ap -eq 0){ Say "==> Ecriture de test supprimee proprement." } else { Say "==> DELETE n'a pas retire la ligne. On peut restaurer la sauvegarde si besoin." }
  $conn.Close()
} catch { Say "DELETE KO: $($_.Exception.Message.Split([char]10)[0]); tu peux restaurer via la sauvegarde backup-prod-*." }

# Retirer le PDF de test
$pdf = "L:\Patients\LIENS\1720\TEST-SANS-MEMO.pdf"
if(Test-Path $pdf){ Remove-Item $pdf -Force; Say "PDF de test supprime." } else { Say "PDF de test deja absent." }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
