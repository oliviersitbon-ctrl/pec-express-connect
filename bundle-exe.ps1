# Copie LogosDevisWriter.exe dans les resources du connecteur (pour qu'il soit embarque).
$ErrorActionPreference='Continue'
$src = "C:\Mes Projets\Mon_Projet\Exe\LogosDevisWriter.exe"
$dstDir = "$env:USERPROFILE\Desktop\pec-express-connect\resources\native"
New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
if(Test-Path $src){
  Copy-Item $src (Join-Path $dstDir "LogosDevisWriter.exe") -Force
  Write-Host "OK - exe copie dans resources\native ($((Get-Item $src).Length) o)"
} else {
  Write-Host "Exe introuvable a $src - verifie le chemin de generation."
}
