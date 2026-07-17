# Inspection v3b : (A) liste les elements de la barre du haut (y 140..275) avec
# position ecran ; (B) remet Logos au premier plan puis capture la zone haut-droite
# (icones Modele / PDF / email / imprimante / Omnicab).
# Lance avec Logos ouvert sur la page DEVIS.

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System; using System.Runtime.InteropServices;
public class Fg {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@

$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$out = "$dir\_uia-toolbar.txt"
$png = "$dir\_toolbar.png"
$L = New-Object System.Collections.Generic.List[string]

$p = Get-Process LOGOS_w -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { "LOGOS_w introuvable" | Out-File $out -Encoding UTF8; Write-Host "LOGOS_w introuvable"; exit }

# Remet Logos au premier plan (SW_RESTORE=9) pour que la capture le montre
[Fg]::ShowWindow($p.MainWindowHandle, 9) | Out-Null
[Fg]::SetForegroundWindow($p.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 600

$root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
$all  = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)

$rows = New-Object System.Collections.Generic.List[object]
foreach ($e in $all) {
  $c = $e.Current
  $r = $c.BoundingRectangle
  if ([double]::IsInfinity($r.X)) { continue }
  if ($r.Y -lt 140 -or $r.Y -gt 275) { continue }
  if ($r.Width -le 0 -or $r.Width -gt 400) { continue }
  $rows.Add([pscustomobject]@{ X=[int]$r.X; Y=[int]$r.Y; W=[int]$r.Width; H=[int]$r.Height; CT=(($c.ControlType.ProgrammaticName) -replace 'ControlType\.',''); Name=($c.Name -replace '\s+',' ').Trim(); Auto=$c.AutomationId })
}
$L.Add("=== elements barre du haut (y 140..275), tries par X ===")
foreach ($row in ($rows | Sort-Object X)) {
  $L.Add(("x={0,4} y={1,4} w={2,3} h={3,3}  {4,-8} name='{5}' auto='{6}'" -f $row.X, $row.Y, $row.W, $row.H, $row.CT, $row.Name, $row.Auto))
}

# (B) Capture zone haut-droite : x 1400..1920, y 140..285
try {
  $cx = 1400; $cy = 140; $cw = 520; $ch = 145
  $bmp = New-Object System.Drawing.Bitmap($cw, $ch)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($cx, $cy, 0, 0, $bmp.Size)
  $bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $L.Add("=== capture: origine ecran x=$cx y=$cy, taille ${cw}x${ch} -> $png ===")
} catch { $L.Add("capture KO: $($_.Exception.Message)") }

$L | Out-File $out -Encoding UTF8
Write-Host "OK -> $out + $png"
