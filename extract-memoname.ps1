# Extrait les noms de champs de ACTES_2 depuis l'analyse Logos (LOGOSWS1.WDD),
# pour trouver le VRAI nom du champ memo (le 61e). Lecture seule.
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_memoname.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

# emplacements possibles de l'analyse Logos
$cands = @("C:\wlogos1\LOGOSWS1.WDD","C:\wlogos1\LOGOSWS1.wdd","L:\LOGOSWS1.WDD","C:\wlogos1\LOGOS.WDD")
$wdd = $null
foreach($c in $cands){ if(Test-Path $c){ $wdd=$c; break } }
if(-not $wdd){
  # chercher tout .wdd sous C:\wlogos1
  $f = Get-ChildItem "C:\wlogos1" -Filter *.wdd -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if($f){ $wdd = $f.FullName }
}
if(-not $wdd){ Say "Analyse Logos (.wdd) introuvable sous C:\wlogos1"; $L|Out-File $out -Encoding UTF8; exit }
Say "Analyse Logos: $wdd ($((Get-Item $wdd).Length) o)"

$bytes = [System.IO.File]::ReadAllBytes($wdd)

# extraire toutes les suites de type identifiant (A-Z 0-9 _), longueur >=3
$cur = New-Object System.Text.StringBuilder
$runs = New-Object System.Collections.Generic.List[string]
$offs = New-Object System.Collections.Generic.List[int]
for($i=0;$i -lt $bytes.Length;$i++){
  $c=$bytes[$i]
  if( ($c -ge 65 -and $c -le 90) -or ($c -ge 97 -and $c -le 122) -or ($c -ge 48 -and $c -le 57) -or $c -eq 95 ){ [void]$cur.Append([char]$c) }
  else { if($cur.Length -ge 3){ $runs.Add($cur.ToString()); $offs.Add($i-$cur.Length) }; $cur.Clear()|Out-Null }
}

# reperer la zone ACTES_2 : autour des noms qu'on connait
$known = @('ACTE_CLE_UNIQUE','MOTIF_DEPASSEMENT','DEP_ACCORD','DEVIS_CLEUNIK','MODIFICATION_REALISEE','HEURE')
Say "----- Contexte autour des champs ACTES_2 connus -----"
for($k=0;$k -lt $runs.Count;$k++){
  if($known -contains $runs[$k]){
    $a=[Math]::Max(0,$k-2); $b=[Math]::Min($runs.Count-1,$k+8)
    Say ("  @$($offs[$k]) [$($runs[$k])] -> voisins: " + (($a..$b | ForEach-Object { $runs[$_] }) -join ' | '))
  }
}

# lister aussi tous les identifiants contenant des mots-cles memo probables
Say "----- Identifiants candidats (MEMO/REMARQUE/COMMENT/DOC/TEXTE/MATERIAU) -----"
$seen=@{}
for($k=0;$k -lt $runs.Count;$k++){
  if($runs[$k] -match 'MEMO|REMARQUE|COMMENT|DOCUMENT|TEXTE|MATERIAU|PIECE|FICHIER|LIEN|NOTE'){
    if(-not $seen.ContainsKey($runs[$k])){ $seen[$runs[$k]]=1; Say ("  @$($offs[$k]) : $($runs[$k])") }
  }
}

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
