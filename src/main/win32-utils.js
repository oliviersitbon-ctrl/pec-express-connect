/**
 * Utilitaires Win32 pour manipuler des fenetres natives depuis Electron.
 *
 * Permet de :
 *  - Attacher une fenetre Electron comme ENFANT d'une autre fenetre (SetParent)
 *    -> elle bouge automatiquement avec son parent
 *  - Detacher une fenetre (revenir top-level)
 *
 * Implementation: PowerShell + DllImport user32.dll (zero dependance npm,
 * marche sur tout Windows 10/11).
 */

const { spawn } = require('child_process');
const { psLoadNative } = require('./native-dll');

let _logger = null;
function setLogger(fn) { _logger = fn; }
function log(msg) {
  const full = `[WIN32] ${msg}`;
  if (_logger) _logger(full); else console.log(full);
}

/**
 * Execute un script PowerShell qui modifie une fenetre via Win32 API.
 * Retourne true si succes.
 */
function runPowerShell(psScript, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
      '-ExecutionPolicy', 'Bypass',
      '-Command', psScript
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString('utf8'); });
    proc.stderr.on('data', d => { stderr += d.toString('utf8'); });
    const timeout = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      resolve({ success: false, error: 'timeout', stdout, stderr });
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ success: code === 0, code, stdout, stderr });
    });
    proc.on('error', e => {
      clearTimeout(timeout);
      resolve({ success: false, error: e.message });
    });
  });
}

/**
 * Attache une fenetre Electron (child) comme ENFANT d'une fenetre native (parent).
 * Apres ca, child bouge avec parent (deplacement, redimensionnement).
 *
 * @param {number} childHwnd - HWND de la fenetre Electron (BrowserWindow.getNativeWindowHandle().readBigUInt64LE() ou .readInt32LE())
 * @param {number} parentHwnd - HWND de la fenetre Logos
 * @param {number} x - position relative au parent
 * @param {number} y - position relative au parent
 */
async function setChildOf(childHwnd, parentHwnd, x, y) {
  // SetParent + ajustement des styles (WS_CHILD)
  // On utilise SetWindowLong pour passer en WS_CHILD, puis SetParent
  const ps = `${psLoadNative('W32C')}
if (-not ('W32C' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32C {
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public const int GWL_STYLE = -16;
    public const int WS_CHILD = 0x40000000;
    public const int WS_POPUP = unchecked((int)0x80000000);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOZORDER = 0x0004;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_SHOWWINDOW = 0x0040;
    public const uint SWP_FRAMECHANGED = 0x0020;
}
"@ -ErrorAction SilentlyContinue
}
$child = [IntPtr]${childHwnd}
$parent = [IntPtr]${parentHwnd}
# Modifier le style: enlever WS_POPUP, ajouter WS_CHILD
$style = [W32C]::GetWindowLong($child, [W32C]::GWL_STYLE)
$newStyle = ($style -band (-bnot [W32C]::WS_POPUP)) -bor [W32C]::WS_CHILD
[W32C]::SetWindowLong($child, [W32C]::GWL_STYLE, $newStyle) | Out-Null
# Attacher
$ret = [W32C]::SetParent($child, $parent)
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
if ($ret -eq [IntPtr]::Zero -and $err -ne 0) {
    Write-Output "SETPARENT_ERR $err"
    exit 1
}
# Repositionner relativement au parent
[W32C]::SetWindowPos($child, [IntPtr]::Zero, ${x}, ${y}, 0, 0, [W32C]::SWP_NOSIZE -bor [W32C]::SWP_NOZORDER -bor [W32C]::SWP_NOACTIVATE -bor [W32C]::SWP_FRAMECHANGED -bor [W32C]::SWP_SHOWWINDOW) | Out-Null
Write-Output "OK"
`;
  const r = await runPowerShell(ps);
  if (r.success && r.stdout.includes('OK')) {
    log(`SetParent OK: child=${childHwnd} parent=${parentHwnd} pos=${x},${y}`);
    return true;
  }
  log(`SetParent FAIL: ${r.stderr || r.stdout || r.error}`);
  return false;
}

/**
 * Detache une fenetre (redevient top-level: parent = NULL/Zero)
 */
async function unsetChild(childHwnd) {
  const ps = `${psLoadNative('W32U')}
if (-not ('W32U' -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W32U {
    [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError=true)] public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    public const int GWL_STYLE = -16;
    public const int WS_CHILD = 0x40000000;
    public const int WS_POPUP = unchecked((int)0x80000000);
}
"@ -ErrorAction SilentlyContinue
}
$child = [IntPtr]${childHwnd}
$style = [W32U]::GetWindowLong($child, [W32U]::GWL_STYLE)
$newStyle = ($style -band (-bnot [W32U]::WS_CHILD)) -bor [W32U]::WS_POPUP
[W32U]::SetWindowLong($child, [W32U]::GWL_STYLE, $newStyle) | Out-Null
[W32U]::SetParent($child, [IntPtr]::Zero) | Out-Null
Write-Output "OK"
`;
  const r = await runPowerShell(ps);
  return r.success && r.stdout.includes('OK');
}

module.exports = { setLogger, setChildOf, unsetChild };
