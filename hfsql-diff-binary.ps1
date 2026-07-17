# Analyse binaire AVANT/APRES d'un import Logos, pour comprendre l'ecriture du memo.
# Compare before\ACTES_2.fic|.mmo a after\ACTES_2.fic|.mmo. Lecture seule.
$ErrorActionPreference='Continue'
$base = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$base\_diff-binary.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }
function Hex($bytes){ ($bytes | ForEach-Object { $_.ToString('x2') }) -join ' ' }
function Ascii($bytes){ -join ($bytes | ForEach-Object { if($_ -ge 32 -and $_ -lt 127){[char]$_}else{'.'} }) }

function Diff-File($name){
  $b = "$base\before\$name"; $a = "$base\after\$name"
  if(-not (Test-Path $b) -or -not (Test-Path $a)){ Say "[$name] before ou after manquant ($b / $a)"; return }
  $bb = [System.IO.File]::ReadAllBytes($b); $ab = [System.IO.File]::ReadAllBytes($a)
  Say "===== $name : avant=$($bb.Length) o, apres=$($ab.Length) o (delta=$($ab.Length-$bb.Length)) ====="
  $min = [Math]::Min($bb.Length,$ab.Length)
  # 1) Trouver les plages differentes DANS la partie commune (scan par blocs pour la vitesse)
  $ranges = New-Object System.Collections.Generic.List[object]
  $i = 0; $blk = 4096
  while($i -lt $min){
    $len = [Math]::Min($blk, $min - $i)
    $same = $true
    for($k=0;$k -lt $len;$k++){ if($bb[$i+$k] -ne $ab[$i+$k]){ $same=$false; break } }
    if(-not $same){
      # scan fin dans ce bloc + etendre
      for($k=0;$k -lt $len;$k++){
        if($bb[$i+$k] -ne $ab[$i+$k]){
          $start=$i+$k; $end=$start
          while($end+1 -lt $min -and $bb[$end+1] -ne $ab[$end+1]){ $end++ }
          $ranges.Add([pscustomobject]@{Start=$start;End=$end})
          $k = $end - $i
        }
      }
    }
    $i += $len
  }
  Say ("  Plages modifiees dans la partie commune: " + $ranges.Count)
  $shown=0
  foreach($r in $ranges){
    if($shown -ge 6){ Say "  ... (autres plages omises)"; break }
    $s=[Math]::Max(0,$r.Start-8); $e=[Math]::Min($min-1,$r.End+8); $n=$e-$s+1
    if($n -gt 400){ $e=$s+399; $n=400 }
    $seg_b = $bb[$s..$e]; $seg_a = $ab[$s..$e]
    Say ("  --- offset {0} (0x{0:x}) .. {1}, {2} octets ---" -f $r.Start,$r.End,($r.End-$r.Start+1))
    Say ("    AVANT hex : " + (Hex $seg_b)); Say ("    AVANT txt : " + (Ascii $seg_b))
    Say ("    APRES hex : " + (Hex $seg_a)); Say ("    APRES txt : " + (Ascii $seg_a))
    $shown++
  }
  # 2) Partie ajoutee a la fin (append)
  if($ab.Length -gt $bb.Length){
    $s=$bb.Length; $e=[Math]::Min($ab.Length-1, $s+399)
    $seg=$ab[$s..$e]
    Say ("  --- AJOUT en fin, offset {0} (0x{0:x}), {1} octets (max 400 affiches) ---" -f $s,($ab.Length-$bb.Length))
    Say ("    hex : " + (Hex $seg)); Say ("    txt : " + (Ascii $seg))
  }
  Say ""
}

Diff-File "ACTES_2.fic"
Diff-File "ACTES_2.mmo"
Diff-File "ACTES_2.ndx"

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
