# Etape 1 (LECTURE SEULE, aucune ecriture) : cree un DSN utilisateur "LOGOSPROD"
# qui lit DIRECTEMENT la prod L:\Patients (clone de LOGOSCOPY avec RepFic=L:),
# puis lit ACTES_2 pour confirmer l'acces prod. Ne modifie AUCUNE donnee.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_prod-read.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 1) Retrouver la config de LOGOSCOPY (pour cloner le Driver et les cles)
$src = $null
foreach($p in @("HKLM:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY","HKCU:\SOFTWARE\ODBC\ODBC.INI\LOGOSCOPY","HKLM:\SOFTWARE\WOW6432Node\ODBC\ODBC.INI\LOGOSCOPY")){
  if(Test-Path $p){ $src = $p; break }
}
if(-not $src){ Say "LOGOSCOPY introuvable dans le registre."; $L|Out-File $out -Encoding UTF8; exit }
Say "Source DSN: $src"
$props = Get-ItemProperty $src
$props.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' } | ForEach-Object { Say ("   {0} = {1}" -f $_.Name,$_.Value) }

# 2) Creer le DSN utilisateur LOGOSPROD (HKCU, pas besoin d'admin), RepFic = L:\Patients
$dst = "HKCU:\SOFTWARE\ODBC\ODBC.INI\LOGOSPROD"
New-Item -Path $dst -Force | Out-Null
foreach($pr in $props.PSObject.Properties){
  if($pr.Name -match '^PS'){ continue }
  $val = $pr.Value
  if($pr.Name -match '^(RepFic|ServerName|Database|Directory)$'){ $val = 'L:\Patients\' }
  New-ItemProperty -Path $dst -Name $pr.Name -Value $val -PropertyType String -Force | Out-Null
}
# forcer RepFic = L:\Patients meme si absent a la source
New-ItemProperty -Path $dst -Name 'RepFic' -Value 'L:\Patients\' -PropertyType String -Force | Out-Null
# enregistrer le DSN dans la liste des sources utilisateur
$drv = $props.Driver
New-Item -Path "HKCU:\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources" -Force | Out-Null
New-ItemProperty -Path "HKCU:\SOFTWARE\ODBC\ODBC.INI\ODBC Data Sources" -Name 'LOGOSPROD' -Value $drv -PropertyType String -Force | Out-Null
Say "DSN LOGOSPROD cree (RepFic=L:\Patients\, Driver=$drv)."

# 3) Lire la prod directement
$cs = "DSN=LOGOSPROD;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
Say "----- Lecture prod directe (L:) -----"
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion prod OK"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2"; $n=[int]$c.ExecuteScalar(); Say "  COUNT(*) prod = $n"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 5 ACTE_CLE_UNIQUE, NUMERO, DATE FROM ACTES_2 ORDER BY ACTE_CLE_UNIQUE DESC"; $rd=$c.ExecuteReader()
  while($rd.Read()){ Say ("  cle=$($rd[0]) patient=$($rd[1]) date=$($rd[2])") }
  $rd.Close(); $conn.Close()
  Say "==> Si tu vois les cles ci-dessus, on lit la prod en direct (sans copie)."
} catch { Say "  Lecture prod KO: $($_.Exception.Message.Split([char]10)[0])" }

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
