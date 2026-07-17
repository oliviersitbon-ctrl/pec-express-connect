# TEST PROD (patient 1720 = SITBON) : est-ce que le document apparait dans Logos
# SANS memo ? On sauvegarde, on insere UN enregistrement, on pose un PDF de test.
# LOGOS DOIT ETRE FERME pendant l'ecriture. Tout est reversible (backup + cle notee).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_prod-test.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# 0) Logos doit etre ferme (ecriture directe en prod)
$logos = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'logos' }
if($logos){ Say "!!! FERME LOGOS d'abord (ecriture en prod), puis relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Say "Logos ferme : OK"

# 1) SAUVEGARDE de ACTES_2 (filet de securite)
$stamp = (Get-Date -Format 'yyyyMMdd-HHmm')
$bkp = "$env:USERPROFILE\Desktop\pec-express-connect\backup-prod-$stamp"
New-Item -ItemType Directory -Path $bkp -Force | Out-Null
try { Copy-Item 'L:\Patients\ACTES_2.*' $bkp -Force; Say "Sauvegarde faite dans: $bkp" }
catch { Say "Sauvegarde KO: $($_.Exception.Message.Split([char]10)[0])"; $L|Out-File $out -Encoding UTF8; exit }

# 2) INSERT d'un enregistrement de document pour 1720 (mimique l'import, SANS memo)
$cs = "DSN=LOGOSPROD;Analyse=C:\My Projects\My_Project\My_Project.wdd;"
$date = (Get-Date -Format 'yyyyMMdd'); $heure = (Get-Date -Format 'HHmm'); $am = (Get-Date -Format 'yyyyMM')
$newCle = $null
try {
  $conn = New-Object System.Data.Odbc.OdbcConnection($cs); $conn.Open(); Say "Connexion prod OK"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT COUNT(*) FROM ACTES_2 WHERE NUMERO=1720"; $av=[int]$c.ExecuteScalar(); Say "Avant: $av actes pour 1720"
  $sql = "INSERT INTO ACTES_2 (NUMERO, DATE, HEURE, ANNEE_MOIS, PRATICIEN, ID_UTILISATEUR) VALUES (1720, '$date', '$heure', '$am', 'OS', 'OS')"
  $c=$conn.CreateCommand(); $c.CommandText=$sql; $r=$c.ExecuteNonQuery(); Say "INSERT prod ok (lignes=$r)"
  $c=$conn.CreateCommand(); $c.CommandText="SELECT TOP 1 ACTE_CLE_UNIQUE FROM ACTES_2 WHERE NUMERO=1720 ORDER BY ACTE_CLE_UNIQUE DESC"; $newCle=[int]$c.ExecuteScalar()
  Say "==> Nouvelle ecriture: ACTE_CLE_UNIQUE = $newCle  (a supprimer apres le test)"
  $conn.Close()
} catch { Say "INSERT prod KO: $($_.Exception.Message.Split([char]10)[0])" }

# 3) Poser un PDF de test dans LIENS\1720
$liens = "L:\Patients\LIENS\1720"
New-Item -ItemType Directory -Path $liens -Force | Out-Null
$pdfPath = Join-Path $liens "TEST-SANS-MEMO.pdf"
# PDF minimal valide avec un texte visible
$pdf = "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`n4 0 obj<</Length 60>>stream`nBT /F1 18 Tf 40 100 Td (TEST DEVIS SANS MEMO) Tj ET`nendstream endobj`n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`nxref`n0 6`n0000000000 65535 f `ntrailer<</Root 1 0 R/Size 6>>`nstartxref`n0`n%%EOF"
[System.IO.File]::WriteAllText($pdfPath, $pdf)
Say "PDF de test pose: $pdfPath"

Say ""
Say "=================================================="
Say "MAINTENANT : rouvre Logos, ouvre le dossier 1720 (SITBON Olivier),"
Say "va dans l'onglet Documents, et regarde s'il y a un document aujourd'hui."
Say "Note la cle a supprimer ensuite: $newCle"
Say "=================================================="

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
