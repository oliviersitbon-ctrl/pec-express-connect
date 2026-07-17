// MddButton.cs — Bouton "MD" (Mon Devis Dentaire) INTEGRE dans la fenetre Logos (non flottant).
// Rattache une fenetre enfant (SetParent) a Logos, sous l'icone imprimante. Affichage seul.
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;
using System.IO;

class MddButton : Form
{
    [DllImport("user32.dll")] static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int i);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr h, int i, int v);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    delegate bool EnumProc(IntPtr h, IntPtr l);
    struct RECT { public int L, T, R, B; }
    const int GWL_STYLE = -16;
    const int WS_CHILD = 0x40000000;
    const int WS_POPUP = unchecked((int)0x80000000);
    const uint SWP_NOMOVE = 0x2, SWP_NOSIZE = 0x1, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40;

    // ---- Reglages a calibrer ----
    const int SIZE = 32;
    const int FROM_RIGHT = 43;   // centre imprimante depuis le bord DROIT (client)
    const int PRINTER_Y = 145;   // centre imprimante depuis le HAUT (client)
    const int GAP = 30;          // distance sous l'imprimante

    string logPath;
    IntPtr logos = IntPtr.Zero;
    Timer timer;
    int tick = 0;

    void Log(string m) { try { File.AppendAllText(logPath, DateTime.Now.ToString("HH:mm:ss") + "  " + m + "\r\n"); } catch { } }

    static IntPtr FindLogos()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, l) =>
        {
            if (!IsWindowVisible(h)) return true;
            var sb = new StringBuilder(512); GetWindowText(h, sb, 512);
            var t = sb.ToString();
            if (t.IndexOf("LOGOS_w", StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    MddButton()
    {
        logPath = Path.Combine(Application.StartupPath, "_mdd-btn-log.txt");
        try { File.WriteAllText(logPath, "=== MddButton demarre ===\r\n"); } catch { }
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Size = new Size(SIZE, SIZE);
        DoubleBuffered = true;
        this.Paint += (s, e) => Draw(e.Graphics);
        this.Load += (s, e) => Attach();
        timer = new Timer(); timer.Interval = 500; timer.Tick += (s, e) => Reposition(); timer.Start();
    }

    void Attach()
    {
        logos = FindLogos();
        if (logos == IntPtr.Zero) { Log("Logos INTROUVABLE (fenetre 'LOGOS_w')"); return; }
        Log("Logos trouve hwnd=" + logos.ToInt64());
        IntPtr r = SetParent(this.Handle, logos);
        Log("SetParent -> ancien parent=" + r.ToInt64());
        int st = GetWindowLong(this.Handle, GWL_STYLE);
        st = (st & ~WS_POPUP) | WS_CHILD;
        SetWindowLong(this.Handle, GWL_STYLE, st);
        SetWindowPos(this.Handle, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
        using (var p = RoundPath(new Rectangle(0, 0, SIZE, SIZE), 8))
            this.Region = new Region(p);
        Reposition();
    }

    void Reposition()
    {
        if (logos == IntPtr.Zero || !IsWindow(logos)) { Attach(); return; }
        RECT c; if (!GetClientRect(logos, out c)) { Log("GetClientRect echec"); return; }
        int printerX = c.R - FROM_RIGHT;
        int x = printerX - SIZE / 2;
        int y = PRINTER_Y + GAP;
        this.Location = new Point(x, y);
        this.BringToFront();
        if ((tick++ % 6) == 0) Log("clientW=" + c.R + " clientH=" + c.B + " -> bouton (" + x + "," + y + ") visible=" + this.Visible);
    }

    static GraphicsPath RoundPath(Rectangle r, int rad)
    {
        var p = new GraphicsPath(); int d = rad * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure(); return p;
    }

    void Draw(Graphics g)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        var rect = new Rectangle(0, 0, SIZE, SIZE);
        using (var path = RoundPath(new Rectangle(0, 0, SIZE - 1, SIZE - 1), 8))
        using (var br = new LinearGradientBrush(rect, Color.White, Color.White, 135f))
        {
            var cb = new ColorBlend();
            cb.Colors = new[] { Color.FromArgb(0x63,0x66,0xF1), Color.FromArgb(0x8B,0x5C,0xF6), Color.FromArgb(0xEC,0x48,0x99) };
            cb.Positions = new[] { 0f, 0.5f, 1f };
            br.InterpolationColors = cb;
            g.FillPath(br, path);
        }
        using (var f = new Font("Segoe UI", 11f, FontStyle.Bold))
        using (var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
            g.DrawString("MD", f, Brushes.White, rect, sf);
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.Run(new MddButton());
    }
}
