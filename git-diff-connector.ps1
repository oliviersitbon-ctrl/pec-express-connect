# Montre les modifs locales non commitees de index.js et overlay-pec.js
$r = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$r\_git-diff.txt"
# resume
$stat = git -C $r --no-pager diff --stat -- src/main/index.js src/main/overlay-pec.js 2>&1
# diff complet
$diff = git -C $r --no-pager diff -- src/main/index.js src/main/overlay-pec.js 2>&1
# dernier commit qui a touche ces fichiers (contexte)
$log = git -C $r --no-pager log -3 --oneline -- src/main/index.js src/main/overlay-pec.js 2>&1

$content = @()
$content += "===== STAT ====="
$content += $stat
$content += ""
$content += "===== DERNIERS COMMITS SUR CES FICHIERS ====="
$content += $log
$content += ""
$content += "===== DIFF COMPLET ====="
$content += $diff
$content | Out-File $out -Encoding UTF8
Write-Host "Ecrit dans $out"
