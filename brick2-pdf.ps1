# Brique 2 - clic INVISIBLE sur le bouton PDF de Logos (aucun mouvement souris,
# pas besoin de mettre Logos au premier plan).
# Essaie dans l'ordre : UIA Invoke -> LegacyIAccessible DoDefaultAction -> PostMessage.
# Localise le bouton PDF en scannant un pane ~32x32 vers (1764,163).

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System; using System.Runtime.InteropServices;
public class Native {
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr h, ref POINT p);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

$dir = "$env:USERPROFILE\Desktop\pec-express-connect"
$L = New-Object System.Collections.Generic.List[string]
function Say($m) { $L.Add($m); Write-Host $m }

$p = Get-Process LOGOS_w -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $p) { Say "LOGOS_w introuvable"; $L | Out-File "$dir\_brick2-log.txt" -Encoding UTF8; exit }
$hwnd = $p.MainWindowHandle
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)

# --- Localiser le bouton PDF : pane de ~32x32 dont le centre est proche de (1780,179) ---
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$pdf = $null; $bestD = 99999
foreach ($e in $all) {
  $r = $e.Current.BoundingRectangle
  if ([double]::IsInfinity($r.X)) { continue }
  if ($r.Width -lt 20 -or $r.Width -gt 40 -or $r.Height -lt 20 -or $r.Height -gt 40) { continue }
  $cx = $r.Left + $r.Width / 2; $cy = $r.Top + $r.Height / 2
  $d = [Math]::Abs($cx - 1780) + [Math]::Abs($cy - 179)
  if ($d -lt $bestD) { $bestD = $d; $pdf = $e; $pdfRect = $r }
}
if (-not $pdf) { Say "Bouton PDF introuvable au scan"; $L | Out-File "$dir\_brick2-log.txt" -Encoding UTF8; exit }
$cx = [int]($pdfRect.Left + $pdfRect.Width / 2); $cy = [int]($pdfRect.Top + $pdfRect.Height / 2)
Say ("PDF trouve: centre=($cx,$cy) auto='$($pdf.Current.AutomationId)' name='$($pdf.Current.Name)' (dist=$bestD)")

# Patterns supportes ?
$pats = $pdf.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }
Say ("Patterns: " + ($pats -join ', '))

$done = $false

# 1) UIA Invoke
try {
  $ip = $pdf.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  if ($ip) { $ip.Invoke(); Say "METHODE: UIA Invoke -> envoye"; $done = $true }
} catch { Say "Invoke KO: $($_.Exception.Message)" }

# 2) LegacyIAccessible DoDefaultAction
if (-not $done) {
  try {
    $lp = $pdf.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    if ($lp) { $lp.DoDefaultAction(); Say "METHODE: LegacyIAccessible DoDefaultAction -> envoye"; $done = $true }
  } catch { Say "DoDefaultAction KO: $($_.Exception.Message)" }
}

# 3) PostMessage (clic en arriere-plan a la position, coords client)
if (-not $done) {
  $pt = New-Object Native+POINT; $pt.X = $cx; $pt.Y = $cy
  [Native]::ScreenToClient($hwnd, [ref]$pt) | Out-Null
  $lParam = [IntPtr](($pt.Y -shl 16) -bor ($pt.X -band 0xFFFF))
  [Native]::PostMessage($hwnd, 0x0201, [IntPtr]1, $lParam) | Out-Null   # WM_LBUTTONDOWN
  Start-Sleep -Milliseconds 40
  [Native]::PostMessage($hwnd, 0x0202, [IntPtr]0, $lParam) | Out-Null   # WM_LBUTTONUP
  Say "METHODE: PostMessage clic en (client $($pt.X),$($pt.Y)) -> envoye"
  $done = $true
}

Start-Sleep -Milliseconds 1500
$L | Out-File "$dir\_brick2-log.txt" -Encoding UTF8
Write-Host "FIN"
