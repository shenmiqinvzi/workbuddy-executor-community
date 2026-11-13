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
        var start = new ProcessStartInfo(node) { WorkingDirectory = gateway, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
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
    private readonly Label message = new() { Dock = DockStyle.Fill, Text = "正在连接本地任务记录…", TextAlign = ContentAlignment.MiddleCenter, Padding = new Padding(40, 32, 40, 32), Font = new Font("Microsoft YaHei UI", 11), ForeColor = Color.FromArgb(65, 82, 95) };
    private readonly Button retry = new() { Text = "重新连接", AutoSize = true, Visible = false, Anchor = AnchorStyles.None };
    // The retry button lives in its own bottom strip. Floating it over the label made it land on top
    // of a multi-line dependency message, so the operator read the button and not the instruction.
    private readonly Panel failureBar = new() { Dock = DockStyle.Bottom, Height = 64, Visible = false, BackColor = Color.FromArgb(243, 246, 248) };
    // Only the process this window started is ever owned here; a retry or an exit event can act on
    // it only while this window still owns it, so an episode cannot stop its replacement.
    private readonly OwnedHost<Process> host = new();
    // Stage transitions, per-stage durations and the step currently being waited on. The ledger is
    // what a status read reports while WebView2 creation is still pending.
    private readonly StartupProgress progress = new();
    private int episode;
    private DesktopCommandChannel? commands;
    private NotifyIcon? tray;
    // The native shell remembers which episode it already showed, so a duplicate frame from a
    // reconnecting host cannot turn one episode into two banners. The ledger in Node is the
    // authority; this set only prevents repainting the same id inside one window session.
    private readonly HashSet<string> notifiedEpisodes = new(StringComparer.Ordinal);
    private bool confirming;
    private Uri? origin;
    private string? currentTask;
    private bool ready, closing;

    public WorkbenchWindow(DesktopOptions options)
    {
        this.options = options; currentTask = options.TaskId;
        Text = "WorkBuddy · 任务工作台";
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
        StartPosition = FormStartPosition.CenterScreen;
        Size = new Size(1280, 860); MinimumSize = new Size(800, 600);
        BackColor = Color.FromArgb(243, 246, 248);
        Controls.Add(web); Controls.Add(message); Controls.Add(failureBar); failureBar.Controls.Add(retry);
        retry.Click += async (_, _) => await StartAsync();
        failureBar.Resize += (_, _) => CenterRetry();
        Shown += async (_, _) => { _ = ListenAsync(); await StartAsync(); };
        FormClosing += (_, _) => { closing = true; lifetime.Cancel(); tray?.Dispose(); tray = null; StopHost(); };
    }

    private async Task StartAsync()
    {
        // One episode at a time: a retry pressed while a start is still pending starts nothing, so a
        // slow environment cannot be raced by a second host or a second WebView window.
        if (closing || !progress.TryBegin()) return;
        var ownEpisode = ++episode;
        ready = false; message.Visible = true; failureBar.Visible = false; retry.Visible = false; message.Text = "正在连接本地任务记录…";
        try
        {
            StopHost();
            if (web.CoreWebView2 is null && web.IsHandleCreated) { Controls.Remove(web); web.Dispose(); web = CreateWebView(); Controls.Add(web); web.SendToBack(); }
            StartupStep.Run(progress, "runtime", () =>
            {
                if (!File.Exists(options.NodeExecutable)) throw new StartupFaultException("NodeMissing", "未找到 Node.js：" + options.NodeExecutable + "。请先安装 Node.js（>=22.13），或用 WORKBUDDY_NODE_EXE 指定 node.exe 的绝对路径，然后点“重新连接”。");
                if (!File.Exists(Path.Combine(options.GatewayDirectory, "scripts", "workbench-desktop-host.mjs"))) throw new StartupFaultException("GatewayIncomplete", "网关目录不完整：缺少 " + Path.Combine(options.GatewayDirectory, "scripts", "workbench-desktop-host.mjs") + "。请重新解压预览包。");
                // Detect the runtime without installing it or touching another app's profile.
                _ = CoreWebView2Environment.GetAvailableBrowserVersionString();
            });
            // The preview package ships without node_modules by design: name the directory and the
            // recovery command before a host is started that cannot import its own modules.
            var dependencies = StartupStep.Run(progress, "dependencies", () => GatewayDependencies.Inspect(options.GatewayDirectory));
            if (!dependencies.Installed) throw new GatewayDependencyException(dependencies);
            var ownHost = StartupStep.Run(progress, "host", StartHost);
            host.Adopt(ownHost);
            // Drain stderr; never copy possibly sensitive upstream diagnostics into the UI or logs.
            _ = Task.Run(async () => { while (await ownHost.StandardError.ReadLineAsync() is { } diagnostic) { if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine(diagnostic); } });
            var line = await StartupStep.RunAsync(progress, "host_ready", StartupProgress.HostReadyBudgetMs, token => ownHost.StandardOutput.ReadLineAsync(token).AsTask(), lifetime.Token);
            if (line is null || line.Length > 4096) throw new InvalidOperationException("本地记录服务启动失败，请核对数据目录和网关版本。");
            using var reply = JsonDocument.Parse(line);
            if (reply.RootElement.GetProperty("event").GetString() != "desktop_host_ready" || !reply.RootElement.GetProperty("port").TryGetInt32(out var port) || port is < 1 or > 65535) throw new InvalidOperationException("本地记录服务的启动回报无效。");
            origin = new Uri("http://127.0.0.1:" + port);
            progress.Enter("webview");
            commands = new DesktopCommandChannel(ownHost);
            // One reader owns the host's stdout: the command channel hands every non-result frame to
            // this handler. A second concurrent reader silently swallowed command results.
            commands.Frame = HandleHostFrame;
            ownHost.EnableRaisingEvents = true;
            ownHost.Exited += (_, _) => { try { if (!closing && host.Owns(ownHost) && IsHandleCreated) BeginInvoke(() => { progress.Fail("host_exited", "the local recording service ended before the page was ready"); ShowFailure("本地记录连接已结束。任务执行仍由原执行器管理，可以重新连接查看。"); }); } catch (InvalidOperationException) { } };
            if (web.CoreWebView2 is null)
            {
                StartupStep.Run(progress, "profile", () => Directory.CreateDirectory(options.ProfileDirectory));
                // Diagnostics only: a loopback debugging port stays closed unless the operator opts in,
                // because any local process could otherwise drive the page.
                CoreWebView2EnvironmentOptions? environmentOptions = null;
                if (int.TryParse(Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DEBUG_PORT"), out var debugPort) && debugPort is > 0 and < 65536)
                    environmentOptions = new CoreWebView2EnvironmentOptions { AdditionalBrowserArguments = "--remote-debugging-port=" + debugPort };
                // The environment and the controller are separate bounded steps: reporting a single
                // "webview" stage cannot tell a stuck environment from a stuck controller.
                var environment = await StartupStep.RunAsync(progress, "webview_environment", StartupProgress.WebViewEnvironmentBudgetMs, _ => CoreWebView2Environment.CreateAsync(null, options.ProfileDirectory, environmentOptions), lifetime.Token);
                await StartupStep.RunAsync(progress, "controller", StartupProgress.ControllerBudgetMs, _ => web.EnsureCoreWebView2Async(environment), lifetime.Token);
                ConfigureWebView();
            }
            progress.Enter("navigate");
            web.CoreWebView2!.Navigate(DesktopOptions.PageUri(origin, currentTask).AbsoluteUri);
            _ = WatchNavigationAsync(ownEpisode);
        }
        catch (OperationCanceledException) when (closing) { progress.Close(); }
        catch (StartupStepTimeoutException timeout)
        {
            // The step already recorded timeout: or interrupted: for its stage; a bound that expired
            // is never reported as the operator cancelling or as the task stopping.
            Report(timeout);
            StopHost(); ShowFailure(TimeoutMessage(timeout));
            Console.WriteLine(JsonSerializer.Serialize(Snapshot("status")));
        }
        catch (WebView2RuntimeNotFoundException error) { progress.Fail("WebView2RuntimeNotFound", "the WebView2 runtime is not installed"); Report(error); StopHost(); ShowFailure("需要 Microsoft Edge WebView2 Runtime。请安装微软官方运行组件后重试。"); }
        catch (GatewayDependencyException missing) { progress.Fail("GatewayDependenciesMissing", "the gateway node_modules directory is missing or incomplete"); Report(missing); StopHost(); ShowFailure(missing.Message); }
        catch (StartupFaultException fault) { progress.Fail(fault.Code, "startup precondition failed: " + fault.Code); Report(fault); StopHost(); ShowFailure(fault.Message); }
        catch (UnauthorizedAccessException error) { progress.Fail("UnauthorizedAccessException", "the profile or data directory was refused"); Report(error); StopHost(); ShowFailure("工作台无法创建本地应用数据。请检查当前 Windows 用户的文件夹访问权限，然后重新连接。"); }
        catch (Exception error) { progress.Fail(error.GetType().Name, "startup stopped at stage " + progress.Stage); Report(error); StopHost(); ShowFailure("工作台暂时无法连接。请检查 Node.js、数据目录、网关依赖及 WebView2 Runtime 后重试。"); }
        finally { progress.End(); }
    }

    private Process StartHost()
    {
        var start = DesktopCommandChannel.StartInfo(options.NodeExecutable, options.GatewayDirectory);
        start.ArgumentList.Add(Path.Combine(options.GatewayDirectory, "scripts", "workbench-desktop-host.mjs"));
        start.Environment["WORKBUDDY_DB_FILE"] = options.Database;
        start.Environment["WORKBUDDY_RUNS_DIR"] = options.RunsDirectory;
        return Process.Start(start) ?? throw new InvalidOperationException("本地记录服务没有启动。");
    }

    private static void Report(Exception error)
    {
        if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine(error);
    }

    private static string TimeoutMessage(StartupStepTimeoutException timeout)
    {
        var waited = timeout.BoundMs / 1000;
        return timeout.Stage switch
        {
            "host_ready" => $"本地记录服务在 {waited} 秒内没有回报就绪。可以重新连接；若重复出现，请保留阶段名 host_ready 与诊断日志。",
            "webview_environment" => $"网页运行环境（WebView2 environment）在 {waited} 秒内没有创建成功。可以重新连接；若重复出现，请保留阶段名 webview_environment 与诊断日志。",
            "controller" => $"网页运行环境已创建，但控制器在 {waited} 秒内没有就绪。可以重新连接；若重复出现，请保留阶段名 controller 与诊断日志。",
            _ => $"工作台在 {timeout.Stage} 阶段等待 {waited} 秒仍未返回。可以重新连接；若重复出现，请保留阶段名 {timeout.Stage} 与诊断日志。",
        };
    }

    /// <summary>
    /// A page that never reports a successful navigation would otherwise sit on the navigate stage
    /// forever. The watchdog records an explicit timeout for that stage instead.
    /// </summary>
    private async Task WatchNavigationAsync(int ownEpisode)
    {
        try { await Task.Delay(StartupProgress.NavigationBudgetMs, lifetime.Token); } catch (OperationCanceledException) { return; }
        if (closing || ready || ownEpisode != episode || progress.IsFailed) return;
        progress.TimeOut("navigate", StartupProgress.NavigationBudgetMs, "the page did not report a successful navigation within its bound");
        StopHost(); ShowFailure($"工作台页面在 {StartupProgress.NavigationBudgetMs / 1000} 秒内没有报告载入完成。可以重新连接；若重复出现，请保留阶段名 navigate 与诊断日志。");
        Console.WriteLine(JsonSerializer.Serialize(Snapshot("status")));
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
        core.FrameNavigationStarting += (_, e) => { if (!options.AllowsEmbed(e.Uri, "GET")) e.Cancel = true; };
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
        core.WebResourceRequested += (_, e) =>
        {
            if (origin is not null && (DesktopControlPolicy.IsRoute(origin, e.Request.Uri, "/workbench/desktop/capabilities", e.Request.Method, "GET")
                || DesktopControlPolicy.IsRoute(origin, e.Request.Uri, "/workbench/desktop/command", e.Request.Method, "POST")))
            {
                var deferral = e.GetDeferral();
                _ = HandleDesktopResourceAsync(e, deferral);
                return;
            }
            if (origin is null || !(DesktopOptions.AllowedRequest(origin, e.Request.Uri, e.Request.Method)
                || options.AllowsEmbed(e.Request.Uri, e.Request.Method)))
                e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(), 403, "Forbidden", "Content-Type: text/plain");
        };
        core.NavigationCompleted += (_, e) =>
        {
            if (closing) return;
            if (!e.IsSuccess) { progress.Fail("navigation", "the page reported a failed navigation"); ShowFailure("工作台页面没有载入，可以重新连接。"); return; }
            // A page that loads after the recording service already ended is not a working page.
            if (host.Current is not { HasExited: false }) { progress.Fail("host_gone", "the local recording service was no longer running when the page loaded"); ShowFailure("本地记录连接已结束。任务执行仍由原执行器管理，可以重新连接查看。"); return; }
            ready = true; message.Visible = false; retry.Visible = false; web.BringToFront();
            progress.Ready();
            Console.WriteLine(JsonSerializer.Serialize(Snapshot("ready")));
        };
    }

    private async Task HandleDesktopResourceAsync(CoreWebView2WebResourceRequestedEventArgs e, CoreWebView2Deferral deferral)
    {
        object reply;
        var status = 200;
        try
        {
            if (origin is null || !DesktopControlPolicy.IsTrustedPage(origin, web.CoreWebView2.Source)) throw new DesktopCommandError("UNTRUSTED_PAGE", "此页面不能调用桌面操作。");
            if (e.Request.Method == "GET") reply = new { ok = true, value = new { available = true, confirmation = "native", controls = Environment.GetEnvironmentVariable("WORKBUDDY_DESKTOP_DISPATCH_ENABLED") == "1" } };
            else
            {
                if (!ready || commands is null) throw new DesktopCommandError("DESKTOP_NOT_READY", "本地连接尚未就绪，请稍后重试。");
                if (!e.Request.Headers.Contains("Content-Type") || !e.Request.Headers.GetHeader("Content-Type").Split(';')[0].Trim().Equals("application/json", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("JSON content required.");
                using var body = new MemoryStream();
                var buffer = new byte[8192];
                var input = e.Request.Content;
                while (input is not null)
                {
                    var count = await input.ReadAsync(buffer);
                    if (count == 0) break;
                    if (body.Length + count > DesktopControlPolicy.MaximumBodyBytes) throw new ArgumentException("Desktop request exceeded its bound.");
                    body.Write(buffer, 0, count);
                }
                var request = DesktopControlPolicy.Decode(Encoding.UTF8.GetString(body.ToArray()));
                JsonElement result;
                if (request.Action == "choose_workspace")
                {
                    if (confirming) throw new DesktopCommandError("CONFIRMATION_BUSY", "请先完成当前确认窗口。");
                    using var picker = new FolderBrowserDialog { Description = "选择已有项目文件夹", UseDescriptionForTitle = true, ShowNewFolderButton = false };
                    confirming = true;
                    try { result = JsonSerializer.SerializeToElement(new { directory = picker.ShowDialog(this) == DialogResult.OK ? picker.SelectedPath : null }); }
                    finally { confirming = false; }
                }
                else if (request.Action == "dispatch")
                {
                    if (confirming) throw new DesktopCommandError("CONFIRMATION_BUSY", "请先完成当前确认窗口。");
                    confirming = true;
                    try
                    {
                        var draft = await commands.CallAsync("review", request.Parameters);
                        if (!DesktopDispatchConfirmation.Show(this, draft)) throw new DesktopCommandError("CONFIRMATION_CANCELLED", "尚未派工，可返回继续核对约定。");
                        result = await commands.CallAsync("commit", request.Parameters);
                    }
                    finally { confirming = false; }
                }
                else if (request.Action == "control")
                {
                    if (confirming) throw new DesktopCommandError("CONFIRMATION_BUSY", "请先完成当前确认窗口。");
                    confirming = true;
                    try
                    {
                        var draft = await commands.CallAsync("control_review", request.Parameters);
                        if (!DesktopControlConfirmation.Show(this, draft)) throw new DesktopCommandError("CONFIRMATION_CANCELLED", "尚未执行操作，可返回继续核对。");
                        result = await commands.CallAsync("control_commit", request.Parameters);
                    }
                    finally { confirming = false; }
                }
                else if (request.Action == "productivity_export_save")
                {
                    if (confirming) throw new DesktopCommandError("CONFIRMATION_BUSY", "请先完成当前确认窗口。");
                    confirming = true;
                    try
                    {
                        var directory = request.Parameters.TryGetProperty("directory", out var chosen) ? chosen.GetString() : null;
                        if (string.IsNullOrWhiteSpace(directory))
                        {
                            using var picker = new FolderBrowserDialog { Description = "选择导出保存文件夹", UseDescriptionForTitle = true, ShowNewFolderButton = true };
                            if (picker.ShowDialog(this) != DialogResult.OK) throw new DesktopCommandError("CONFIRMATION_CANCELLED", "尚未保存导出，可以重新选择文件夹。");
                            directory = picker.SelectedPath;
                        }
                        if (!DesktopProductivityConfirmation.ShowExportSave(this, request.Parameters, directory)) throw new DesktopCommandError("CONFIRMATION_CANCELLED", "尚未保存导出，可以返回继续核对预览。");
                        var parameters = JsonSerializer.SerializeToElement(new { taskId = request.Parameters.GetProperty("taskId").GetString(), digest = request.Parameters.GetProperty("digest").GetString(), directory });
                        result = await commands.CallAsync("productivity_export_save", parameters);
                    }
                    finally { confirming = false; }
                }
                else if (request.Action == "productivity_template_save")
                {
                    if (confirming) throw new DesktopCommandError("CONFIRMATION_BUSY", "请先完成当前确认窗口。");
                    confirming = true;
                    try
                    {
                        if (!DesktopProductivityConfirmation.ShowTemplateSave(this, request.Parameters)) throw new DesktopCommandError("CONFIRMATION_CANCELLED", "尚未保存模板，可以返回继续修改。");
                        result = await commands.CallAsync("productivity_template_save", request.Parameters);
                    }
                    finally { confirming = false; }
                }
                else result = await commands.CallAsync(request.Action, request.Parameters);
                reply = new { ok = true, value = result };
            }
        }
        catch (DesktopCommandError error) { reply = new { ok = false, error = new { code = error.Code, message = error.Message } }; }
        catch (Exception) { status = 400; reply = new { ok = false, error = new { code = "INVALID_DESKTOP_REQUEST", message = "本次请求未完成。请保留原任务编号，核对约定或重新连接后查询，勿重复派工。" } }; }
        try
        {
            if (!closing && web.CoreWebView2 is { } core)
                e.Response = core.Environment.CreateWebResourceResponse(new MemoryStream(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(reply))), status, status == 200 ? "OK" : "Bad Request", "Content-Type: application/json; charset=utf-8\r\nCache-Control: no-store");
        }
        finally { deferral.Complete(); }
    }

    /// <summary>
    /// Reads the host's event frames after the ready line. Only a banner is shown: the native shell
    /// never approves, retries, extends a deadline or writes task state from a notification, and
    /// closing the window does not remove any task evidence.
    /// </summary>
    private void HandleHostFrame(JsonElement frame)
    {
        try
        {
            if (!frame.TryGetProperty("event", out var kind) || kind.GetString() != "desktop_notification") return;
            if (!frame.TryGetProperty("notification", out var notification) || notification.ValueKind != JsonValueKind.Object) return;
            ShowNotification(notification);
        }
        catch (InvalidOperationException) { }
    }

    private void ShowNotification(JsonElement notification)
    {
        if (closing || !IsHandleCreated) return;
        var id = notification.TryGetProperty("notificationId", out var identifier) ? identifier.GetString() : null;
        if (string.IsNullOrWhiteSpace(id) || !notifiedEpisodes.Add(id)) return;
        string Text(string name) => notification.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? string.Empty : string.Empty;
        var title = Text("taskTitle");
        var reason = Text("reason") switch
        {
            "input_requested" => "等待你提供信息",
            "needs_review" => "已停止，等待验收",
            "failed" => "执行失败",
            "deadline" => "已超过约定时限",
            _ => "任务有新进展",
        };
        var body = $"{(title.Length == 0 ? "任务" : title)}：{reason}\r\n任务编号 {Text("taskId")}。通知不改变任务状态；请回到工作台查看证据。";
        BeginInvoke(() =>
        {
            if (closing) return;
            tray ??= new NotifyIcon { Icon = SystemIcons.Application, Text = "WorkBuddy 任务通知", Visible = true };
            tray.BalloonTipTitle = "WorkBuddy";
            tray.BalloonTipText = body;
            tray.BalloonTipIcon = ToolTipIcon.Info;
            tray.ShowBalloonTip(8000);
        });
    }

    private void CenterRetry() => retry.Location = new Point(Math.Max(0, (failureBar.ClientSize.Width - retry.Width) / 2), Math.Max(8, (failureBar.ClientSize.Height - retry.Height) / 2));

    private void ShowFailure(string text)
    {
        if (closing) return;
        ready = false; message.Text = text; message.Visible = true; failureBar.Visible = true; retry.Visible = true; message.BringToFront(); failureBar.BringToFront();
        CenterRetry();
    }

    /// <summary>
    /// The status reply. <c>startupStage</c> and <c>failureCode</c> keep their previous meaning;
    /// <c>startup</c> adds the bounded facts (per-stage durations, the step being waited on and its
    /// bound) so a pending WebView2 step is distinguishable from a stopped shell.
    /// </summary>
    private object Snapshot(string state) => new { status = state, pid = Environment.ProcessId, windowHandle = Handle.ToInt64(), gatewayPid = host.Current is { HasExited: false } running ? running.Id : (int?)null, ready, taskId = currentTask, page = origin is null ? null : DesktopOptions.PageUri(origin, currentTask).AbsoluteUri, startupStage = progress.Stage, failureCode = progress.FailureCode, startup = progress.Describe() };

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
        commands?.Dispose(); commands = null;
        // Only a host this window still owns is stopped; an episode's replacement is never touched.
        var own = host.Current is { } running ? host.ReleaseIfOwned(running) : null;
        if (own is null) return;
        try { if (!own.HasExited) { try { own.StandardInput.Close(); } catch (IOException) { } if (!own.WaitForExit(2500)) own.Kill(); } }
        catch (InvalidOperationException) { }
        finally { own.Dispose(); }
    }

    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
