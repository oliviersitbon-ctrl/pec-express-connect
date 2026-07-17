# Met a jour les depots git (MDD/Labora + connecteur) en fast-forward seulement.
# Ne supprime pas les fichiers non suivis (nos scripts, l'exe, logos-devis-writer.js...).
$ErrorActionPreference='Continue'
$out = "$env:USERPROFILE\Desktop\pec-express-connect\_git-update.txt"
$L = New-Object System.Collections.Generic.List[string]
function Say($m){ $L.Add([string]$m); Write-Host $m }

$repos = @(
  "$env:USERPROFILE\Desktop\pec-express",
  "$env:USERPROFILE\Desktop\pec-express-connect",
  "$env:USERPROFILE\Desktop\labora-dental-excellence"
)

foreach($r in $repos){
  Say ""
  Say "==================== $r ===================="
  if(-not (Test-Path (Join-Path $r ".git"))){ Say "  (pas un depot git)"; continue }

  $branch = (git -C $r rev-parse --abbrev-ref HEAD 2>&1)
  Say "  Branche: $branch"

  Say "  --- fetch ---"
  (git -C $r fetch --all --prune 2>&1) | ForEach-Object { Say "    $_" }

  Say "  --- etat local (fichiers modifies/non suivis) ---"
  (git -C $r status -sb 2>&1) | ForEach-Object { Say "    $_" }

  Say "  --- commits en retard sur origin ---"
  $behind = (git -C $r log --oneline "HEAD..@{u}" 2>&1)
  if($behind){ $behind | ForEach-Object { Say "    $_" } } else { Say "    (a jour)" }

  Say "  --- pull (fast-forward only) ---"
  (git -C $r pull --ff-only 2>&1) | ForEach-Object { Say "    $_" }
}

$L | Out-File $out -Encoding UTF8
Write-Host "Fini."
