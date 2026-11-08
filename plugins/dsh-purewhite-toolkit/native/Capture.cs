// dsh-purewhite-toolkit / Capture.cs
//
// 截图与窗口探测的底层实现。由 scripts/build-helper.mjs 用系统自带 csc.exe
// 编译成 build/dshtool-capture.exe，Node 侧每次调用只付 ~0.2s 进程启动成本。
//
// 输出：stdout 一行 JSON（成功 {"ok":true,...}，失败 {"ok":false,"code":...,"message":...}）。
// 参数：
//   --mode screen|monitor|window|region|list
//   --out <file>            保存路径（mode=list 时忽略）
//   --monitor <1-based>     仅 mode=monitor
//   --hwnd <decimal>        仅 mode=window
//   --title <substring>     仅 mode=window，标题子串匹配（不区分大小写）
//   --x --y --w --h         仅 mode=region，虚拟桌面物理像素
//   --scale <0.1-1.0>       缩放比例，与 --maxedge 二选一
//   --maxedge <px>          长边上限，内部按比例缩放
//   --format png|jpeg
//   --cursor 0|1            是否画上鼠标指针（仅整屏/显示器/区域）
//   --restore 0|1           目标窗口最小化时是否临时恢复后截图（默认 0）
//
// 兼容 C# 5（.NET Framework 自带的 csc 编译器），不用字符串插值和空条件运算符。

using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

class Capture
{
    const int PW_RENDERFULLCONTENT = 2;
    const int SW_MINIMIZE = 6;
    const int SW_SHOWNOACTIVATE = 4;
    const int CURSOR_SHOWING = 1;
    const uint DI_NORMAL = 3;
    const uint SRCCOPY = 0x00CC0020;

    [StructLayout(LayoutKind.Sequential)]
    struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, IntPtr lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [DllImport("user32.dll")] static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetAwarenessFromDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] static extern bool GetCursorInfo(ref CURSORINFO pci);
    [DllImport("user32.dll")] static extern bool DrawIconEx(IntPtr hdc, int x, int y, IntPtr hIcon, int cx, int cy, uint step, IntPtr brush, uint flags);
    [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr hdcDest, int x, int y, int w, int h, IntPtr hdcSrc, int sx, int sy, uint rop);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    static int Main(string[] args)
    {
        try
        {
            SetProcessDPIAware();
            // Node 侧按 UTF-8 读取 stdout；窗口标题与路径可能含中文，必须显式设置。
            try { Console.OutputEncoding = new UTF8Encoding(false); }
            catch { }
            Dictionary<string, string> opt = ParseArgs(args);
            string mode = GetStr(opt, "mode", "screen");

            if (mode == "list")
            {
                Console.WriteLine(ListWindowsJson());
                return 0;
            }

            List<string> warnings = new List<string>();
            Bitmap bmp = null;
            RECT bounds = new RECT();
            string winTitle = null;
            string winClass = null;
            long hwndUsed = 0;
            bool dpiAdjusted = false;
            bool wasIconic = false;

            if (mode == "screen")
            {
                bounds = VirtualScreenBounds();
                bmp = CaptureRect(bounds);
                if (GetBool(opt, "cursor", false)) DrawCursor(bmp, bounds.Left, bounds.Top);
            }
            else if (mode == "monitor")
            {
                int index = GetInt(opt, "monitor", 0);
                if (index <= 0)
                {
                    Console.WriteLine(Fail("MonitorMissing", "--monitor requires a 1-based index"));
                    return 0;
                }
                List<RECT> monitors = EnumerateMonitors();
                if (index > monitors.Count)
                {
                    Console.WriteLine(Fail("MonitorNotFound", "--monitor " + index + " is out of range; " + monitors.Count + " monitor(s) present"));
                    return 0;
                }
                bounds = monitors[index - 1];
                bmp = CaptureRect(bounds);
                if (GetBool(opt, "cursor", false)) DrawCursor(bmp, bounds.Left, bounds.Top);
            }
            else if (mode == "window")
            {
                IntPtr hwnd = IntPtr.Zero;
                long rawHwnd = GetLong(opt, "hwnd", 0);
                if (rawHwnd != 0) hwnd = new IntPtr(rawHwnd);

                if (hwnd == IntPtr.Zero)
                {
                    string title = GetStr(opt, "title", null);
                    if (title == null || title.Length == 0)
                    {
                        Console.WriteLine(Fail("WindowSelectorMissing", "target=window needs either 'window' (title substring) or 'hwnd'"));
                        return 0;
                    }
                    List<WindowInfo> matches = FindWindows(title);
                    if (matches.Count == 0)
                    {
                        string json = Fail("WindowNotFound", "no visible window title contains \"" + title + "\"");
                        json = json.Substring(0, json.Length - 1) + ",\"candidates\":" + CandidatesJson(12) + "}";
                        Console.WriteLine(json);
                        return 0;
                    }
                    WindowInfo chosen = null;
                    for (int i = 0; i < matches.Count; i++)
                    {
                        if (!matches[i].Iconic) { chosen = matches[i]; break; }
                    }
                    if (chosen == null) chosen = matches[0];
                    hwnd = chosen.Handle;
                }

                if (!IsWindowVisible(hwnd))
                {
                    Console.WriteLine(Fail("WindowNotVisible", "window " + hwnd.ToInt64() + " is not visible"));
                    return 0;
                }

                wasIconic = IsIconic(hwnd);
                if (wasIconic && !GetBool(opt, "restore", false))
                {
                    Console.WriteLine(Fail("WindowMinimized", "window " + hwnd.ToInt64() + " is minimized; pass restore=true to allow a brief un-minimize"));
                    return 0;
                }

                winTitle = WindowTitle(hwnd);
                winClass = WindowClass(hwnd);
                hwndUsed = hwnd.ToInt64();

                RECT rect = WindowCaptureRect(hwnd, wasIconic);
                if (rect.Right - rect.Left <= 0 || rect.Bottom - rect.Top <= 0)
                {
                    Console.WriteLine(Fail("WindowRectEmpty", "window " + hwnd.ToInt64() + " has an empty rectangle"));
                    return 0;
                }

                int targetW = rect.Right - rect.Left;
                int targetH = rect.Bottom - rect.Top;
                if (IsDpiUnaware(hwnd))
                {
                    uint dpi = GetDpiForWindow(hwnd);
                    if (dpi > 96)
                    {
                        double factor = dpi / 96.0;
                        targetW = (int)Math.Round(targetW / factor);
                        targetH = (int)Math.Round(targetH / factor);
                        dpiAdjusted = true;
                    }
                }

                if (wasIconic)
                {
                    ShowWindow(hwnd, SW_SHOWNOACTIVATE);
                    Thread.Sleep(350);
                    warnings.Add("WindowRestoredTemporarily");
                }

                try
                {
                    bmp = new Bitmap(targetW, targetH);
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        IntPtr dc = g.GetHdc();
                        bool ok = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT);
                        g.ReleaseHdc(dc);
                        if (!ok) warnings.Add("PrintWindowReturnedFalse");
                    }

                    double mean;
                    double uniform;
                    Analyze(bmp, out mean, out uniform);
                    if (uniform > 0.995)
                    {
                        // 有些窗口（尤其 GPU 合成）PrintWindow 拿到空表面；窗口此刻可见的话改用屏幕拷贝兜底。
                        Bitmap fallback = CopyFromScreen(rect);
                        double fbMean;
                        double fbUniform;
                        Analyze(fallback, out fbMean, out fbUniform);
                        if (fbUniform < uniform)
                        {
                            bmp.Dispose();
                            bmp = fallback;
                            warnings.Add("ScreenFallbackUsed");
                        }
                        else
                        {
                            fallback.Dispose();
                        }
                    }
                }
                finally
                {
                    if (wasIconic) ShowWindow(hwnd, SW_MINIMIZE);
                }

                bounds = rect;
            }
            else if (mode == "region")
            {
                int x = GetInt(opt, "x", 0);
                int y = GetInt(opt, "y", 0);
                int w = GetInt(opt, "w", 0);
                int h = GetInt(opt, "h", 0);
                if (w <= 0 || h <= 0)
                {
                    Console.WriteLine(Fail("RegionMissing", "target=region requires region.width and region.height"));
                    return 0;
                }
                RECT vs = VirtualScreenBounds();
                RECT want;
                want.Left = x;
                want.Top = y;
                want.Right = x + w;
                want.Bottom = y + h;

                RECT clipped = Intersect(want, vs);
                if (clipped.Right - clipped.Left <= 0 || clipped.Bottom - clipped.Top <= 0)
                {
                    Console.WriteLine(Fail("RegionOutsideScreen", "requested region does not intersect the virtual screen"));
                    return 0;
                }
                if (clipped.Left != want.Left || clipped.Top != want.Top || clipped.Right != want.Right || clipped.Bottom != want.Bottom)
                    warnings.Add("RegionClippedToScreen");

                Bitmap full = CaptureRect(vs);
                bmp = Crop(full, clipped, vs.Left, vs.Top);
                full.Dispose();
                bounds = clipped;
                if (GetBool(opt, "cursor", false)) DrawCursor(bmp, clipped.Left, clipped.Top);
            }
            else
            {
                Console.WriteLine(Fail("BadMode", "unknown mode: " + mode));
                return 0;
            }

            string format = GetStr(opt, "format", "png");
            int maxEdge = GetInt(opt, "maxedge", 0);
            double scale = GetDouble(opt, "scale", 0);
            if (maxEdge > 0 || (scale > 0 && scale < 1.0))
            {
                int limit;
                if (maxEdge > 0) limit = maxEdge;
                else limit = (int)Math.Round(Math.Max(bmp.Width, bmp.Height) * scale);
                bmp = Downscale(bmp, limit);
            }

            double finalMean;
            double finalUniform;
            Analyze(bmp, out finalMean, out finalUniform);

            string outPath = GetStr(opt, "out", null);
            if (outPath == null || outPath.Length == 0)
            {
                bmp.Dispose();
                Console.WriteLine(Fail("OutputMissing", "--out is required"));
                return 0;
            }

            SaveImage(bmp, outPath, format);

            StringBuilder sb = new StringBuilder();
            sb.Append("{\"ok\":true");
            sb.Append(",\"mode\":").Append(J(mode));
            sb.Append(",\"path\":").Append(J(outPath));
            sb.Append(",\"width\":").Append(bmp.Width);
            sb.Append(",\"height\":").Append(bmp.Height);
            sb.Append(",\"bounds\":{\"x\":").Append(bounds.Left)
              .Append(",\"y\":").Append(bounds.Top)
              .Append(",\"width\":").Append(bounds.Right - bounds.Left)
              .Append(",\"height\":").Append(bounds.Bottom - bounds.Top).Append("}");
            sb.Append(",\"mean\":").Append(finalMean.ToString("F2", CultureInfo.InvariantCulture));
            sb.Append(",\"uniform\":").Append(finalUniform.ToString("F4", CultureInfo.InvariantCulture));
            if (hwndUsed != 0)
            {
                sb.Append(",\"window\":{\"hwnd\":").Append(hwndUsed)
                  .Append(",\"title\":").Append(J(winTitle))
                  .Append(",\"class\":").Append(J(winClass))
                  .Append(",\"wasMinimized\":").Append(wasIconic ? "true" : "false")
                  .Append(",\"dpiAdjusted\":").Append(dpiAdjusted ? "true" : "false")
                  .Append("}");
            }
            sb.Append(",\"warnings\":[");
            for (int i = 0; i < warnings.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append(J(warnings[i]));
            }
            sb.Append("]}");

            bmp.Dispose();
            Console.WriteLine(sb.ToString());
            return 0;
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.ToString());
            Console.WriteLine(Fail("CaptureFailed", e.GetType().Name + ": " + e.Message));
            return 0;
        }
    }

    // ---------- 截图 ----------

    static RECT VirtualScreenBounds()
    {
        Rectangle r = System.Windows.Forms.SystemInformation.VirtualScreen;
        RECT rect;
        rect.Left = r.Left;
        rect.Top = r.Top;
        rect.Right = r.Right;
        rect.Bottom = r.Bottom;
        return rect;
    }

    static Bitmap CaptureRect(RECT rect)
    {
        int w = rect.Right - rect.Left;
        int h = rect.Bottom - rect.Top;
        Bitmap bmp = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(bmp))
        {
            g.CopyFromScreen(rect.Left, rect.Top, 0, 0, new Size(w, h));
        }
        return bmp;
    }

    static Bitmap CopyFromScreen(RECT rect)
    {
        return CaptureRect(rect);
    }

    static Bitmap Crop(Bitmap source, RECT rect, int originX, int originY)
    {
        int x = rect.Left - originX;
        int y = rect.Top - originY;
        int w = rect.Right - rect.Left;
        int h = rect.Bottom - rect.Top;
        Bitmap crop = new Bitmap(w, h);
        using (Graphics g = Graphics.FromImage(crop))
        {
            g.DrawImage(source, new Rectangle(0, 0, w, h), new Rectangle(x, y, w, h), GraphicsUnit.Pixel);
        }
        return crop;
    }

    static Bitmap Downscale(Bitmap source, int longEdge)
    {
        int w = source.Width;
        int h = source.Height;
        double ratio = 1.0;
        if (w >= h && w > longEdge) ratio = (double)longEdge / w;
        else if (h > w && h > longEdge) ratio = (double)longEdge / h;
        if (ratio >= 1.0) return source;

        int nw = Math.Max(1, (int)Math.Round(w * ratio));
        int nh = Math.Max(1, (int)Math.Round(h * ratio));
        Bitmap scaled = new Bitmap(nw, nh);
        using (Graphics g = Graphics.FromImage(scaled))
        {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            g.DrawImage(source, new Rectangle(0, 0, nw, nh));
        }
        source.Dispose();
        return scaled;
    }

    static void DrawCursor(Bitmap bmp, int originX, int originY)
    {
        try
        {
            CURSORINFO ci = new CURSORINFO();
            ci.cbSize = Marshal.SizeOf(ci);
            if (!GetCursorInfo(ref ci)) return;
            if (ci.flags != CURSOR_SHOWING) return;
            int x = ci.ptScreenPos.X - originX;
            int y = ci.ptScreenPos.Y - originY;
            using (Graphics g = Graphics.FromImage(bmp))
            {
                IntPtr dc = g.GetHdc();
                DrawIconEx(dc, x, y, ci.hCursor, 0, 0, 0, IntPtr.Zero, DI_NORMAL);
                g.ReleaseHdc(dc);
            }
        }
        catch
        {
            // 画指针失败不影响截图
        }
    }

    static void SaveImage(Bitmap bmp, string path, string format)
    {
        bool jpeg = string.Equals(format, "jpeg", StringComparison.OrdinalIgnoreCase)
                 || string.Equals(format, "jpg", StringComparison.OrdinalIgnoreCase);
        if (!jpeg)
        {
            bmp.Save(path, ImageFormat.Png);
            return;
        }

        ImageCodecInfo codec = null;
        foreach (ImageCodecInfo info in ImageCodecInfo.GetImageEncoders())
        {
            if (info.FormatID == ImageFormat.Jpeg.Guid) { codec = info; break; }
        }
        if (codec == null)
        {
            bmp.Save(path, ImageFormat.Png);
            return;
        }
        EncoderParameters ps = new EncoderParameters(1);
        ps.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 88L);
        bmp.Save(path, codec, ps);
    }

    static void Analyze(Bitmap bmp, out double mean, out double uniform)
    {
        long sum = 0;
        int total = 0;
        Dictionary<int, int> buckets = new Dictionary<int, int>();

        int step = Math.Max(1, Math.Min(bmp.Width, bmp.Height) / 200);
        for (int y = 0; y < bmp.Height; y += step)
        {
            for (int x = 0; x < bmp.Width; x += step)
            {
                Color c = bmp.GetPixel(x, y);
                sum += (c.R + c.G + c.B) / 3;
                total++;
                int key = ((c.R >> 4) << 8) | ((c.G >> 4) << 4) | (c.B >> 4);
                if (buckets.ContainsKey(key)) buckets[key] = buckets[key] + 1;
                else buckets[key] = 1;
            }
        }

        int max = 0;
        foreach (KeyValuePair<int, int> kv in buckets)
        {
            if (kv.Value > max) max = kv.Value;
        }

        mean = total == 0 ? 0 : (double)sum / total;
        uniform = total == 0 ? 1 : (double)max / total;
    }

    // ---------- 窗口 ----------

    sealed class WindowInfo
    {
        public IntPtr Handle;
        public string Title;
        public string Class;
        public RECT Rect;
        public bool Iconic;
    }

    static List<WindowInfo> EnumerateWindows()
    {
        List<WindowInfo> list = new List<WindowInfo>();
        EnumWindows(delegate(IntPtr h, IntPtr p)
        {
            if (!IsWindowVisible(h)) return true;
            string title = WindowTitle(h);
            if (title == null || title.Trim().Length == 0) return true;
            WindowInfo info = new WindowInfo();
            info.Handle = h;
            info.Title = title;
            info.Class = WindowClass(h);
            RECT r;
            GetWindowRect(h, out r);
            info.Rect = r;
            info.Iconic = IsIconic(h);
            list.Add(info);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    static List<WindowInfo> FindWindows(string needle)
    {
        List<WindowInfo> all = EnumerateWindows();
        List<WindowInfo> hit = new List<WindowInfo>();
        for (int i = 0; i < all.Count; i++)
        {
            if (all[i].Title.IndexOf(needle, StringComparison.CurrentCultureIgnoreCase) >= 0)
                hit.Add(all[i]);
        }
        return hit;
    }

    static string CandidateTitles(int limit)
    {
        List<WindowInfo> all = EnumerateWindows();
        StringBuilder sb = new StringBuilder();
        int count = 0;
        for (int i = 0; i < all.Count && count < limit; i++)
        {
            if (all[i].Iconic) continue;
            if (count > 0) sb.Append(" | ");
            sb.Append(all[i].Title);
            count++;
        }
        return sb.ToString();
    }

    static string CandidatesJson(int limit)
    {
        List<WindowInfo> all = EnumerateWindows();
        StringBuilder sb = new StringBuilder("[");
        int count = 0;
        for (int i = 0; i < all.Count && count < limit; i++)
        {
            if (all[i].Iconic) continue;
            if (count > 0) sb.Append(",");
            sb.Append("{\"hwnd\":").Append(all[i].Handle.ToInt64())
              .Append(",\"title\":").Append(J(all[i].Title))
              .Append(",\"class\":").Append(J(all[i].Class)).Append("}");
            count++;
        }
        sb.Append("]");
        return sb.ToString();
    }

    static string ListWindowsJson()
    {
        List<WindowInfo> all = EnumerateWindows();
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"ok\":true,\"windows\":[");
        for (int i = 0; i < all.Count; i++)
        {
            if (i > 0) sb.Append(",");
            sb.Append("{\"hwnd\":").Append(all[i].Handle.ToInt64())
              .Append(",\"title\":").Append(J(all[i].Title))
              .Append(",\"class\":").Append(J(all[i].Class))
              .Append(",\"minimized\":").Append(all[i].Iconic ? "true" : "false")
              .Append(",\"rect\":{\"x\":").Append(all[i].Rect.Left)
              .Append(",\"y\":").Append(all[i].Rect.Top)
              .Append(",\"width\":").Append(all[i].Rect.Right - all[i].Rect.Left)
              .Append(",\"height\":").Append(all[i].Rect.Bottom - all[i].Rect.Top).Append("}}");
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static RECT WindowCaptureRect(IntPtr hwnd, bool iconic)
    {
        if (!iconic)
        {
            RECT r;
            GetWindowRect(hwnd, out r);
            return r;
        }
        WINDOWPLACEMENT placement = new WINDOWPLACEMENT();
        placement.length = Marshal.SizeOf(placement);
        if (GetWindowPlacement(hwnd, ref placement)) return placement.rcNormalPosition;
        RECT fallback;
        GetWindowRect(hwnd, out fallback);
        return fallback;
    }

    static bool IsDpiUnaware(IntPtr hwnd)
    {
        try
        {
            IntPtr context = GetWindowDpiAwarenessContext(hwnd);
            if (context == IntPtr.Zero) return false;
            return GetAwarenessFromDpiAwarenessContext(context) == 0;
        }
        catch
        {
            return false;
        }
    }

    static string WindowTitle(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowTextW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static string WindowClass(IntPtr hwnd)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassNameW(hwnd, sb, sb.Capacity);
        return sb.ToString();
    }

    static List<RECT> EnumerateMonitors()
    {
        List<RECT> rects = new List<RECT>();
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate(IntPtr monitor, IntPtr hdc, IntPtr clip, IntPtr data)
        {
            MONITORINFO mi = new MONITORINFO();
            mi.cbSize = Marshal.SizeOf(mi);
            if (GetMonitorInfo(monitor, ref mi)) rects.Add(mi.rcMonitor);
            return true;
        }, IntPtr.Zero);
        return rects;
    }

    static RECT Intersect(RECT a, RECT b)
    {
        RECT r;
        r.Left = Math.Max(a.Left, b.Left);
        r.Top = Math.Max(a.Top, b.Top);
        r.Right = Math.Min(a.Right, b.Right);
        r.Bottom = Math.Min(a.Bottom, b.Bottom);
        if (r.Right < r.Left) r.Right = r.Left;
        if (r.Bottom < r.Top) r.Bottom = r.Top;
        return r;
    }

    // ---------- 参数与 JSON ----------

    static Dictionary<string, string> ParseArgs(string[] args)
    {
        Dictionary<string, string> map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (a.StartsWith("--"))
            {
                string key = a.Substring(2);
                string value = (i + 1 < args.Length && !args[i + 1].StartsWith("--")) ? args[i + 1] : "true";
                if (value != "true") i++;
                map[key] = value;
            }
        }
        return map;
    }

    static string GetStr(Dictionary<string, string> opt, string key, string fallback)
    {
        if (opt.ContainsKey(key) && opt[key] != "true") return opt[key];
        return fallback;
    }

    static int GetInt(Dictionary<string, string> opt, string key, int fallback)
    {
        string raw = GetStr(opt, key, null);
        int value;
        if (raw != null && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return value;
        return fallback;
    }

    static long GetLong(Dictionary<string, string> opt, string key, long fallback)
    {
        string raw = GetStr(opt, key, null);
        long value;
        if (raw != null && long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return value;
        return fallback;
    }

    static double GetDouble(Dictionary<string, string> opt, string key, double fallback)
    {
        string raw = GetStr(opt, key, null);
        double value;
        if (raw != null && double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out value)) return value;
        return fallback;
    }

    static bool GetBool(Dictionary<string, string> opt, string key, bool fallback)
    {
        if (!opt.ContainsKey(key)) return fallback;
        string raw = opt[key];
        if (raw == "1" || string.Equals(raw, "true", StringComparison.OrdinalIgnoreCase)) return true;
        if (raw == "0" || string.Equals(raw, "false", StringComparison.OrdinalIgnoreCase)) return false;
        return fallback;
    }

    static string J(string value)
    {
        if (value == null) return "null";
        StringBuilder sb = new StringBuilder(value.Length + 2);
        sb.Append('"');
        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }

    static string Fail(string code, string message)
    {
        return "{\"ok\":false,\"code\":" + J(code) + ",\"message\":" + J(message) + "}";
    }
}
