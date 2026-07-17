# TEST D'ECRITURE ODBC sur la COPIE (Desktop\Patients). Insere un enregistrement
# de test (patient 9999) dans ACTES_2 et verifie qu'il apparait. NE TOUCHE PAS la prod.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_insert-test.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
try { $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK (copie)" }
catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])"; $L | Out-File $out -Encoding UTF8; exit }

# 1) compter avant
try { $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE NUMERO=9999"; $n0=[int]$c.ExecuteScalar(); Say "Avant: $n0 enregistrement(s) patient 9999" }
catch { Say "Comptage avant KO: $($_.Exception.Message.Split([char]10)[0])" }

# 2) INSERT de test
$ok=$false
$sql = "INSERT INTO ACTES_2 (NUMERO, DATE, HEURE, ANNEE_MOIS, PRATICIEN, ID_UTILISATEUR) VALUES (9999, '20260716', '0200', '202607', 'OS', 'OS')"
try {
  $c=$conn.CreateCommand(); $c.CommandText=$sql; $r=$c.ExecuteNonQuery()
  Say "INSERT execute (lignes affectees=$r)"; $ok=$true
} catch { Say "INSERT KO: $($_.Exception.Message)" }

# 3) verifier apres
if($ok){
  try {
    $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE NUMERO=9999"; $n1=[int]$c.ExecuteScalar()
    Say "Apres: $n1 enregistrement(s) patient 9999"
    if($n1 -gt $n0){ Say "==> SUCCES : l'ODBC a bien ECRIT dans ACTES_2 !" }
    else { Say "==> L'INSERT n'a pas ajoute de ligne visible." }
    # relire le contenu
    $c=$conn.CreateCommand(); $c.CommandText="SELECT ACTE_CLE_UNIQUE, NUMERO, DATE, HEURE, PRATICIEN FROM ACTES_2 WHERE NUMERO=9999"; $rd=$c.ExecuteReader()
    while($rd.Read()){ Say ("  cle=$($rd[0]) num=$($rd[1]) date=$($rd[2]) heure=$($rd[3]) prat=$($rd[4])") }
    $rd.Close()
  } catch { Say "Verif apres KO: $($_.Exception.Message.Split([char]10)[0])" }
}

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
