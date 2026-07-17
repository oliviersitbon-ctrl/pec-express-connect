# Liste les colonnes+types que LOGOSWS1.WDD expose pour ACTES_2, et cherche un memo.
# Tente aussi de lire le contenu memo d'un enregistrement document. Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_logoswdd-cols.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$wdev = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'wd28|wd29|windev' }
if($wdev){ Say "!!! WinDev ouvert, ferme-le. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Copy-Item 'L:\Patients\ACTES_2.*' "$env:USERPROFILE\Desktop\Patients\" -Force
Say "Copie rafraichie."

$cs = "DSN=LOGOSCOPY;Analyse=C:\wlogos1\LOGOSWS1.WDD;"
try {
  $conn=New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion LOGOSWS1 OK"

  # 1) Schema des colonnes avec type
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 * FROM ACTES_2"; $rd=$c.ExecuteReader()
  $sch = $rd.GetSchemaTable()
  Say "----- Colonnes ACTES_2 (LOGOSWS1) -----"
  $idx=0
  foreach($row in $sch.Rows){
    $nm=$row["ColumnName"]; $dt=$row["DataType"].Name; $sz=$row["ColumnSize"]
    Say ("  {0,2} {1,-28} {2} (taille {3})" -f $idx,$nm,$dt,$sz)
    $idx++
  }
  $rd.Close()

  # 2) chercher un enregistrement document (memo non vide) sur les patients test
  Say "----- Recherche contenu memo (patients 1720/1499, 60 dernieres lignes) -----"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 60 * FROM ACTES_2 ORDER BY 1 DESC"
  $rd=$c.ExecuteReader(); $found=0
  while($rd.Read() -and $found -lt 8){
    for($i=0;$i -lt $rd.FieldCount;$i++){
      if(-not $rd.IsDBNull($i)){
        $v=[string]$rd.GetValue($i)
        if($v -match '<Remarque>|<X>|\.pdf|Materiaux'){ Say ("  ligne: colonne '$($rd.GetName($i))' = [$v]"); $found++ }
      }
    }
  }
  $rd.Close()
  if($found -eq 0){ Say "  (aucun contenu memo detecte dans ces colonnes)" }
  $conn.Close()
} catch { Say "KO: $($_.Exception.Message.Split([char]10)[0])" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
