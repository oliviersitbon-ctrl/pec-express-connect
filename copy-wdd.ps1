# Copie les versions d'analyse .wdd/.wda (dans C:\My Projects, non partage) vers
# pec-express-connect\wdd-versions\ pour que je puisse les analyser. Lecture seule (copie).
$ErrorActionPreference='Continue'
$dst = "$env:USERPROFILE\Desktop\pec-express-connect\wdd-versions"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
$base = "C:\My Projects\My_Project\My_Project.ana"
$src = @{
  "ANA00001" = "$base\ANA00001\My_Project.wdd"
  "ANA00002" = "$base\ANA00002\My_Project.wdd"
  "ANA00003" = "$base\ANA00003\My_Project.wdd"
  "CURRENT"  = "C:\My Projects\My_Project\My_Project.wdd"
}
foreach($k in $src.Keys){
  if(Test-Path $src[$k]){
    Copy-Item $src[$k] (Join-Path $dst ("$k.wdd")) -Force
    Write-Host "Copie $k : $((Get-Item $src[$k]).Length) o"
  } else { Write-Host "absent: $k -> $($src[$k])" }
}
# recopie aussi la version cassee sauvegardee si presente
$brk = "C:\My Projects\My_Project\My_Project.wdd.broken"
if(Test-Path $brk){ Copy-Item $brk (Join-Path $dst "BROKEN.wdd") -Force; Write-Host "Copie BROKEN" }
Write-Host "Fini -> $dst"
