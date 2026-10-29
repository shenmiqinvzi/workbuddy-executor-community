using System.Diagnostics;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WorkBuddy.Workbench;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        DesktopOptions options;
        try
        {
            if (args.Length == 0) args = ResolveLocalOptions();
            options = DesktopOptions.Parse(args);
        }
        catch (Exception e)
        {
            Console.Error.WriteLine(e.Message);
            if (args.Length == 0) MessageBox.Show("无法读取工作台配置。请确认网关依赖已安装，Node.js 可用，且工作台仍位于网关的 desktop/app 目录内。", "WorkBuddy 工作台");
            return 2;
        }
        var user = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Windows identity unavailable.");
        using var mutex = new Mutex(true, "Local\\" + options.PipeName + "." + user, out var first);
        if (!first || options.StatusOnly)
        {
            try
            {
                using var pipe = new NamedPipeClientStream(".", options.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
                pipe.Connect(5000);
                using var write = new StreamWriter(pipe, new UTF8Encoding(false), 1024, leaveOpen: true) { AutoFlush = true };
                write.WriteLine(JsonSerializer.Serialize(new { taskId = options.TaskId, status = options.StatusOnly }));
                using var read = new StreamReader(pipe, Encoding.UTF8, false, 1024, leaveOpen: true);
                var response = read.ReadLineAsync().WaitAsync(TimeSpan.FromSeconds(6)).GetAwaiter().GetResult();
                Console.WriteLine(response);
                return response is null ? 3 : 0;
            }
            catch { Console.Error.WriteLine("Desktop window is not reachable. No second window was started."); return 3; }
        }
        try
        {
            ApplicationConfiguration.Initialize();
            using var window = new WorkbenchWindow(options);
            Application.Run(window);
            return 0;
        }
        catch (Exception e)
        {
            MessageBox.Show("工作台未能启动。\n" + e.Message, "WorkBuddy 工作台", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        finally { if (first) mutex.ReleaseMutex(); }
    }

    private static string[] ResolveLocalOptions()
    {
        var gateway = Directory.GetParent(AppContext.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar))?.Parent?.FullName ?? throw new InvalidOperationException("Missing gateway directory.");
        var configured = Environment.GetEnvironmentVariable("WORKBUDDY_NODE_EXE");
        var node = !string.IsNullOrWhiteSpace(configured) && Path.IsPathFullyQualified(configured) && File.Exists(configured) ? configured
            : (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator).Select(folder => Path.Combine(folder.Trim('"'), "node.exe")).FirstOrDefault(File.Exists)
              ?? throw new InvalidOperationException("Node.js was not found.");
        var start = new ProcessStartInfo(node) { WorkingDirectory = gateway, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        start.ArgumentList.Add(Path.Combine(gateway, "scripts", "open-workbench.mjs")); start.ArgumentList.Add("--resolve-options");
        using var process = Process.Start(start) ?? throw new InvalidOperationException("Cannot resolve gateway configuration.");
        var stdout = process.StandardOutput.ReadToEndAsync(); var stderr = process.StandardError.ReadToEndAsync();
        if (!process.WaitForExit(10000)) { process.Kill(); throw new InvalidOperationException("Configuration lookup timed out."); }
        if (process.ExitCode != 0) throw new InvalidOperationException("Gateway configuration is unavailable.");
        using var doc = JsonDocument.Parse(stdout.GetAwaiter().GetResult());
        return doc.RootElement.GetProperty("arguments").EnumerateArray().Select(v => v.GetString() ?? "").ToArray();
    }
}

internal sealed class WorkbenchWindow : Form
{
    private readonly DesktopOptions options;
    private readonly CancellationTokenSource lifetime = new();
    private WebView2 web = CreateWebView();
    private static WebView2 CreateWebView() => new() { Dock = DockStyle.Fill, DefaultBackgroundColor = Color.FromArgb(243, 246, 248) };
    private readonly Label message = new() { Dock = DockStyle.Fill, Text = "正在连接本地任务记录…", TextAlign = ContentAlignment.MiddleCenter, Font = new Font("Microsoft YaHei UI", 11), ForeColor = Color.FromArgb(65, 82, 95) };
    private readonly Button retry = new() { Text = "重新连接", AutoSize = true, Visible = false, Anchor = AnchorStyles.None };
    private Process? host;
    private Uri? origin;
    private string? currentTask;
    private bool ready, closing, starting;
    private string? failureCode;
    private string startupStage = "created";

    public WorkbenchWindow(DesktopOptions options)
    {
        this.options = options; currentTask = options.TaskId;
        Text = "WorkBuddy · 任务工作台";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1280, 860); MinimumSize = new Size(800, 600);
        BackColor = Color.FromArgb(243, 246, 248);
        Controls.Add(web); Controls.Add(message); Controls.Add(retry);
        retry.Click += async (_, _) => await StartAsync();
        Resize += (_, _) => retry.Location = new Point((ClientSize.Width - retry.Width) / 2, ClientSize.Height / 2 + 52);
        Shown += async (_, _) => { _ = ListenAsync(); await StartAsync(); };
        FormClosing += (_, _) => { closing = true; lifetime.Cancel(); StopHost(); };
    }

    private async Task StartAsync()
    {
        if (starting || closing) return;
        starting = true; ready = false; message.Visible = true; retry.Visible = false; message.Text = "正在连接本地任务记录…";
        try
        {
            failureCode = null; startupStage = "runtime";
            StopHost();
            if (web.CoreWebView2 is null && web.IsHandleCreated) { Controls.Remove(web); web.Dispose(); web = CreateWebView(); Controls.Add(web); web.SendToBack(); }
            if (!File.Exists(options.NodeExecutable) || !File.Exists(Path.Combine(options.GatewayDirectory, "scripts", "workbench-desktop-host.mjs"))) throw new InvalidOperationException("缺少 Node.js 或工作台网关，请检查安装目录。");
            // Detect the runtime without installing it or touching another app's profile.
            _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
            startupStage = "host";
            var start = new ProcessStartInfo(options.NodeExecutable) { WorkingDirectory = options.GatewayDirectory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true };
            start.ArgumentList.Add(Path.Combine(options.GatewayDirectory, "scripts", "workbench-desktop-host.mjs"));
            start.Environment["WORKBUDDY_DB_FILE"] = options.Database;
            start.Environment["WORKBUDDY_RUNS_DIR"] = options.RunsDirectory;
            host = Process.Start(start) ?? throw new InvalidOperationException("本地记录服务没有启动。");
            var ownHost = host;
            startupStage = "host_ready";
            // Drain stderr; never copy possibly sensitive upstream diagnostics into the UI or logs.
            _ = Task.Run(async () => { while (await ownHost.StandardError.ReadLineAsync() is { } diagnostic) { if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine(diagnostic); } });
            var line = await ownHost.StandardOutput.ReadLineAsync(lifetime.Token).AsTask().WaitAsync(TimeSpan.FromSeconds(20), lifetime.Token);
            if (line is null || line.Length > 4096) throw new InvalidOperationException("本地记录服务启动失败，请核对数据目录和网关版本。");
            using var reply = JsonDocument.Parse(line);
            if (reply.RootElement.GetProperty("event").GetString() != "desktop_host_ready" || !reply.RootElement.GetProperty("port").TryGetInt32(out var port) || port is < 1 or > 65535) throw new InvalidOperationException("本地记录服务的启动回报无效。");
            origin = new Uri("http://127.0.0.1:" + port);
            startupStage = "webview";
            _ = Task.Run(async () => { while (await ownHost.StandardOutput.ReadLineAsync() is not null) { } });
            ownHost.EnableRaisingEvents = true;
            ownHost.Exited += (_, _) => { try { if (!closing && host == ownHost && IsHandleCreated) BeginInvoke(() => ShowFailure("本地记录连接已结束。任务执行仍由原执行器管理，可以重新连接查看。")); } catch (InvalidOperationException) { } };
            if (web.CoreWebView2 is null)
            {
                Directory.CreateDirectory(options.ProfileDirectory);
                var environment = await CoreWebView2Environment.CreateAsync(null, options.ProfileDirectory);
                await web.EnsureCoreWebView2Async(environment);
                ConfigureWebView();
            }
            web.CoreWebView2!.Navigate(DesktopOptions.PageUri(origin, currentTask).AbsoluteUri);
            startupStage = "navigate";
        }
        catch (OperationCanceledException) when (closing) { }
        catch (WebView2RuntimeNotFoundException) { StopHost(); ShowFailure("需要 Microsoft Edge WebView2 Runtime。请安装微软官方运行组件后重试。"); }
        catch (UnauthorizedAccessException error) { failureCode = "UnauthorizedAccessException"; if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine(error); StopHost(); ShowFailure("工作台无法创建本地应用数据。请检查当前 Windows 用户的文件夹访问权限，然后重新连接。"); }
        catch (Exception error) { failureCode = error.GetType().Name; if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine(error); StopHost(); ShowFailure("工作台暂时无法连接。请检查 Node.js、数据目录、网关依赖及 WebView2 Runtime 后重试。"); }
        finally { starting = false; }
    }

    private void ConfigureWebView()
    {
        var core = web.CoreWebView2;
        var settings = core.Settings;
        settings.AreHostObjectsAllowed = false; settings.IsWebMessageEnabled = false;
        settings.AreDevToolsEnabled = false; settings.AreDefaultContextMenusEnabled = false;
        settings.IsStatusBarEnabled = false; settings.IsBuiltInErrorPageEnabled = false;
        settings.IsPasswordAutosaveEnabled = false; settings.IsGeneralAutofillEnabled = false;
        core.PermissionRequested += (_, e) => e.State = CoreWebView2PermissionState.Deny;
        core.NewWindowRequested += (_, e) => e.Handled = true;
        core.DownloadStarting += (_, e) => e.Cancel = true;
        core.NavigationStarting += (_, e) => { if (origin is null || !DesktopOptions.AllowedRequest(origin, e.Uri, "GET")) e.Cancel = true; };
        core.FrameNavigationStarting += (_, e) => e.Cancel = true;
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (origin is null || !DesktopOptions.AllowedRequest(origin, e.Request.Uri, e.Request.Method))
                e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(), 403, "Forbidden", "Content-Type: text/plain");
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (closing) return;
            if (!e.IsSuccess) { ShowFailure("工作台页面没有载入，可以重新连接。"); return; }
            ready = true; message.Visible = false; retry.Visible = false; web.BringToFront();
            Console.WriteLine(JsonSerializer.Serialize(Snapshot("ready")));
        };
    }

    private void ShowFailure(string text)
    {
        if (closing) return;
        ready = false; message.Text = text; message.Visible = true; message.BringToFront(); retry.Visible = true; retry.BringToFront();
        retry.Location = new Point((ClientSize.Width - retry.Width) / 2, ClientSize.Height / 2 + 52);
    }

    private object Snapshot(string state) => new { status = state, pid = Environment.ProcessId, windowHandle = Handle.ToInt64(), gatewayPid = host is { HasExited: false } ? host.Id : (int?)null, ready, taskId = currentTask, page = origin is null ? null : DesktopOptions.PageUri(origin, currentTask).AbsoluteUri, startupStage, failureCode };

    private async Task ListenAsync()
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(options.PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime.Token);
                using var bounded = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token); bounded.CancelAfter(3000);
                using var read = new StreamReader(pipe, Encoding.UTF8, false, 1024, leaveOpen: true);
                var bytes = new StringBuilder();
                var one = new char[1];
                while (await read.ReadAsync(one.AsMemory(), bounded.Token) != 0 && one[0] != '\n')
                { bytes.Append(one[0]); if (bytes.Length > 1024) throw new ArgumentException("Message too long."); }
                var task = DesktopOptions.DecodeTaskMessage(bytes.ToString());
                using var document = JsonDocument.Parse(bytes.ToString());
                var statusOnly = document.RootElement.TryGetProperty("status", out var status) && status.ValueKind == JsonValueKind.True;
                if (!statusOnly)
                {
                    if (task is not null) { currentTask = task; if (ready && origin is not null) web.CoreWebView2.Navigate(DesktopOptions.PageUri(origin, task).AbsoluteUri); }
                    if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
                    Show(); Activate(); SetForegroundWindow(Handle);
                }
                using var write = new StreamWriter(pipe, new UTF8Encoding(false), 1024, leaveOpen: true) { AutoFlush = true };
                await write.WriteLineAsync(JsonSerializer.Serialize(Snapshot(statusOnly ? "status" : "activated")));
            }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { break; }
            catch { /* Bad/disconnected local callers cannot take down the window. */ }
        }
    }

    private void StopHost()
    {
        var own = host; host = null;
        if (own is null) return;
        try { if (!own.HasExited) { try { own.StandardInput.Close(); } catch (IOException) { } if (!own.WaitForExit(2500)) own.Kill(); } }
        catch (InvalidOperationException) { }
        finally { own.Dispose(); }
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
