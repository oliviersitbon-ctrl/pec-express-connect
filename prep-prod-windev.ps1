# Prepare le test prod : sauvegarde ACTES_2 + pose un PDF de test dans LIENS\1720.
# LOGOS DOIT ETRE FERME. Reversible (backup).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_prep-prod.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$logos = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'logos' }
if($logos){ Say "!!! FERME LOGOS d'abord, puis relance. !!!"; $L|Out-File $out -Encoding UTF8; exit }
Say "Logos ferme : OK"

# 1) Sauvegarde ACTES_2
$stamp = (Get-Date -Format 'yyyyMMdd-HHmm')
$bkp = "$env:USERPROFILE\Desktop\pec-express-connect\backup-prod-$stamp"
New-Item -ItemType Directory -Path $bkp -Force | Out-Null
try { Copy-Item 'L:\Patients\ACTES_2.*' $bkp -Force; Say "Sauvegarde OK -> $bkp" }
catch { Say "Sauvegarde KO: $($_.Exception.Message.Split([char]10)[0])"; $L|Out-File $out -Encoding UTF8; exit }

# 2) PDF de test dans LIENS\1720
$liens = "L:\Patients\LIENS\1720"
New-Item -ItemType Directory -Path $liens -Force | Out-Null
$pdfPath = Join-Path $liens "TEST-WINDEV.pdf"
$pdf = "%PDF-1.4`n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj`n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj`n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj`n4 0 obj<</Length 55>>stream`nBT /F1 18 Tf 30 100 Td (TEST DEVIS WINDEV) Tj ET`nendstream endobj`n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj`nxref`n0 6`n0000000000 65535 f `ntrailer<</Root 1 0 R/Size 6>>`nstartxref`n0`n%%EOF"
[System.IO.File]::WriteAllText($pdfPath, $pdf)
Say "PDF de test pose : $pdfPath"
Say ""
Say "MAINTENANT : dans WinDev, remplace la 1ere ligne du code par le chemin L: (voir chat),"
Say "puis GO + clic. Ensuite rouvre Logos et regarde le dossier 1720 (SITBON)."

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
