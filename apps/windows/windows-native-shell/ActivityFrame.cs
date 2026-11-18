using System;
using System.Collections.Generic;
using System.Linq;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace ABridge;

internal sealed class ActivityFrames : IDisposable
{
    private readonly List<ActivityFrame> windows = new();
    private string layout = "";
    public void Show(bool active)
    {
        if (!active) { foreach (var window in windows) window.Close(); windows.Clear(); layout = ""; return; }
        var screens = Forms.Screen.AllScreens;
        var next = string.Join(";", screens.Select(s => s.Bounds.ToString()));
        if (next == layout) return;
        Show(false); layout = next;
        foreach (var screen in screens)
        {
            var b = screen.Bounds;
            // Four narrow surfaces keep active animation proportional to perimeter,
            // rather than repainting a full monitor-sized transparent bitmap.
            foreach (var edge in new[] {
                new System.Drawing.Rectangle(b.Left, b.Top, b.Width, 3),
                new System.Drawing.Rectangle(b.Left, b.Bottom - 3, b.Width, 3),
                new System.Drawing.Rectangle(b.Left, b.Top + 3, 3, Math.Max(1, b.Height - 6)),
                new System.Drawing.Rectangle(b.Right - 3, b.Top + 3, 3, Math.Max(1, b.Height - 6)) })
            {
                var window = new ActivityFrame(edge);
                windows.Add(window); window.Show();
            }
        }
    }
    public void Dispose() => Show(false);
}

internal sealed class ActivityFrame : Window
{
    private readonly DispatcherTimer animation;
    private double offset;
    [DllImport("user32.dll")] private static extern IntPtr GetWindowLongPtr(IntPtr h, int index);
    [DllImport("user32.dll")] private static extern IntPtr SetWindowLongPtr(IntPtr h, int index, IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int width, int height, uint flags);
    public ActivityFrame(System.Drawing.Rectangle bounds)
    {
        Title = "aBridge · 正在操作桌面";
        WindowStyle = WindowStyle.None; ResizeMode = ResizeMode.NoResize;
        AllowsTransparency = true; Background = Brushes.Transparent;
        ShowInTaskbar = false; ShowActivated = false; Focusable = false; IsHitTestVisible = false;
        Topmost = true; Width = bounds.Width; Height = bounds.Height;
        animation = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(66) };
        animation.Tick += (_, _) => { if (!SystemParameters.ClientAreaAnimation) animation.Stop(); offset = (offset + 0.7) % 45; InvalidateVisual(); };
        SourceInitialized += (_, _) =>
        {
            var handle = new WindowInteropHelper(this).Handle;
            SetWindowLongPtr(handle, -20, new IntPtr(GetWindowLongPtr(handle, -20).ToInt64() | 0x080000A0));
            SetWindowPos(handle, new IntPtr(-1), bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x10);
        };
        Loaded += (_, _) =>
        {
            // Reassert physical bounds after WPF's initial per-monitor DPI layout.
            SetWindowPos(new WindowInteropHelper(this).Handle, new IntPtr(-1), bounds.X, bounds.Y, bounds.Width, bounds.Height, 0x10);
            if (SystemParameters.ClientAreaAnimation) animation.Start();
        };
        Closed += (_, _) => animation.Stop();
    }
    protected override void OnRender(DrawingContext context)
    {
        base.OnRender(context);
        var horizontal = ActualWidth > ActualHeight;
        var width = horizontal ? ActualHeight : ActualWidth;
        var from = horizontal ? new Point(0, width / 2) : new Point(width / 2, 0);
        var to = horizontal ? new Point(ActualWidth, width / 2) : new Point(width / 2, ActualHeight);
        context.DrawLine(new Pen(new SolidColorBrush(Color.FromArgb(180, 0, 102, 221)), width), from, to);
        if (SystemParameters.ClientAreaAnimation)
        {
            var pen = new Pen(new SolidColorBrush(Color.FromRgb(184, 224, 255)), width) { DashStyle = new DashStyle(new double[] { 30, 15 }, offset) };
            context.DrawLine(pen, from, to);
        }
    }
}
