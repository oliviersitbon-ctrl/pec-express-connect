# Remplace le faux PDF de test par un vrai PDF valide (copie d'un devis existant),
# pour verifier que le document s'ouvre proprement en recliquant. Lecture/copie seulement.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_replace-pdf.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$liens = "L:\Patients\LIENS\1720"
$src = Get-ChildItem $liens -Filter *.pdf -ErrorAction SilentlyContinue |
       Where-Object { $_.Name -ne 'TEST-WINDEV.pdf' -and $_.Length -gt 1000 } |
       Sort-Object Length -Descending | Select-Object -First 1
if($src){
  Copy-Item $src.FullName "$liens\TEST-WINDEV.pdf" -Force
  Say "PDF de test remplace par un vrai PDF : $($src.Name) ($($src.Length) o)"
  Say "-> Reclique le document TEST-WINDEV dans Logos, il doit s'ouvrir proprement."
} else {
  Say "Aucun PDF valide trouve dans $liens. (On en generera un via la brique 2.)"
}
$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
