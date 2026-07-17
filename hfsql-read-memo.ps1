# TEST LECTURE DU MEMO sur la COPIE (Desktop\Patients).
# Objectif : verifier qu'apres avoir ajoute le champ COMMENTAIRE (memo) a l'analyse,
# l'ODBC lit bien le contenu du memo des ecritures existantes (dont l'import PDF).
# NE TOUCHE PAS la prod : on rafraichit d'abord la copie a partir de L:\Patients.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_read-memo.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Rafraichir la copie lue par le DSN (Desktop\Patients) avec la prod
try { Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force; Say "Copie prod -> Desktop\Patients faite." }
catch { Say "Copie KO: $($_.Exception.Message.Split([char]10)[0])" }

$cs = "DSN=LOGOSCOPY;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
try { $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion OK (copie)" }
catch { Say "Connexion KO: $($_.Exception.Message.Split([char]10)[0])"; $L | Out-File $out -Encoding UTF8; exit }

# 2) Verifier que le champ COMMENTAIRE existe bien dans le schema vu par l'ODBC
try {
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $rd=$c.ExecuteReader()
  $cols=@(); for($i=0;$i -lt $rd.FieldCount;$i++){ $cols += $rd.GetName($i) }
  $rd.Close()
  Say "Nb colonnes vues = $($cols.Count)"
  if($cols -contains 'COMMENTAIRE'){ Say "==> Le champ COMMENTAIRE est PRESENT dans le schema ODBC." }
  else { Say "==> ATTENTION : COMMENTAIRE ABSENT. Regenere l'analyse (Generation) avant de relancer." }
  Say ("Derniers champs: " + ($cols[-6..-1] -join ', '))
} catch { Say "Lecture schema KO: $($_.Exception.Message.Split([char]10)[0])" }

# 3) Chercher les ecritures dont le memo n'est pas vide (l'import PDF doit en faire partie)
Say "--- Recherche des ecritures avec un COMMENTAIRE non vide (30 plus recentes) ---"
try {
  $c=$conn.CreateCommand()
  $c.CommandText="SELECT TOP 30 ACTE_CLE_UNIQUE, NUMERO, DATE, HEURE, COMMENTAIRE FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"
  $rd=$c.ExecuteReader(); $found=0
  while($rd.Read()){
    $memo = if($rd.IsDBNull(4)){''}else{[string]$rd.GetValue(4)}
    if($memo.Trim().Length -gt 0){
      $found++
      Say ("  cle=$($rd[0]) num=$($rd[1]) date=$($rd[2]) heure=$($rd[3])")
      Say ("      MEMO = [$memo]")
    }
  }
  $rd.Close()
  if($found -eq 0){ Say "  (aucun memo non vide dans les 30 dernieres ecritures)" }
  else { Say "==> $found ecriture(s) avec memo lisible. Si le texte ressemble a <X><Remarque>...</Remarque></X>, l'alignement est BON." }
} catch { Say "Requete memo KO: $($_.Exception.Message.Split([char]10)[0])" }

$conn.Close()
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
