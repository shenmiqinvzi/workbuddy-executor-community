using System.Collections.Concurrent;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

namespace WorkBuddy.Workbench;

internal sealed class DesktopCommandError(string code, string message) : Exception(message) { public string Code { get; } = code; }
internal sealed class DesktopCommandChannel : IDisposable
{
    private readonly Process host;
    private readonly CancellationTokenSource lifetime = new();
    private readonly SemaphoreSlim write = new(1, 1);
    private readonly ConcurrentDictionary<string, TaskCompletionSource<JsonElement>> pending = new();
    public static ProcessStartInfo StartInfo(string node, string directory) => new(node) { WorkingDirectory = directory, UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, StandardInputEncoding = new UTF8Encoding(false), StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
    public DesktopCommandChannel(Process host) { this.host = host; _ = ReadAsync(); }
    public async Task<JsonElement> CallAsync(string method, JsonElement parameters)
    {
        if (pending.Count >= 16) throw new DesktopCommandError("DESKTOP_BUSY", "当前请求过多，请等待原请求完成。");
        var id = Guid.NewGuid().ToString("D");
        var reply = new TaskCompletionSource<JsonElement>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[id] = reply;
        try
        {
            var line = JsonSerializer.Serialize(new { id, method, parameters });
            if (Encoding.UTF8.GetByteCount(line) > 70000) throw new ArgumentException("Command too large.");
            await write.WaitAsync(lifetime.Token);
            try { await host.StandardInput.WriteLineAsync(line); await host.StandardInput.FlushAsync(); }
            finally { write.Release(); }
            return await reply.Task.WaitAsync(TimeSpan.FromSeconds(90), lifetime.Token);
        }
        finally { pending.TryRemove(id, out _); }
    }
    private async Task ReadAsync()
    {
        try
        {
            var buffer = new char[4096]; var line = new StringBuilder();
            while (!lifetime.IsCancellationRequested)
            {
                var count = await host.StandardOutput.ReadAsync(buffer.AsMemory(), lifetime.Token);
                if (count == 0) break;
                for (var i = 0; i < count; i++)
                {
                    if (buffer[i] != '\n') { line.Append(buffer[i]); if (line.Length > 1_000_000) throw new InvalidDataException("Desktop response too large."); continue; }
                    var payload = line.ToString(); line.Clear();
                    if (string.IsNullOrWhiteSpace(payload)) continue;
                    JsonDocument document;
                    try { document = JsonDocument.Parse(payload); }
                    catch (JsonException error)
                    {
                        if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine($"Desktop frame: length={payload.Length}, first={(int)payload[0]}, byte={error.BytePositionInLine}");
                        throw;
                    }
                    using var parsed = document;
                    var root = document.RootElement;
                    if (root.GetProperty("event").GetString() != "desktop_command_result" || root.GetProperty("id").GetString() is not { } id || !pending.TryGetValue(id, out var reply)) continue;
                    if (root.GetProperty("ok").GetBoolean()) reply.TrySetResult(root.GetProperty("value").Clone());
                    else { var error = root.GetProperty("error"); reply.TrySetException(new DesktopCommandError(error.GetProperty("code").GetString() ?? "DESKTOP_COMMAND_FAILED", error.GetProperty("message").GetString() ?? "本次操作未完成。")); }
                }
            }
        }
        catch (Exception error)
        {
            if (Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_DIAGNOSTICS") == "1") Console.Error.WriteLine("Desktop channel: " + error.GetType().Name);
        }
        finally { foreach (var reply in pending.Values) reply.TrySetException(new DesktopCommandError("DESKTOP_DISCONNECTED", "本地连接已结束。请保留原任务编号，重新打开后查询，勿重复派工。")); }
    }
    public void Dispose() { lifetime.Cancel(); }
}

internal static class DesktopDispatchConfirmation
{
    public static bool Show(IWin32Window owner, JsonElement draft)
    {
        JsonElement contract = draft.GetProperty("contract"), execution = contract.GetProperty("execution"), quote = draft.GetProperty("quote"), scope = contract.GetProperty("scope");
        string S(JsonElement value, string name) => value.GetProperty(name).ValueKind == JsonValueKind.Null ? "未提供" : value.GetProperty(name).ToString();
        string Items(JsonElement value) => string.Join(Environment.NewLine, value.EnumerateArray().Select(p => "  " + p.ToString()));
        var unknown = !quote.GetProperty("pricingVerified").GetBoolean() || quote.GetProperty("credits").ValueKind == JsonValueKind.Null;
        var summary = $"{S(contract,"title")}\r\n\r\n项目\r\n{S(draft.GetProperty("workspace"),"realPath")}\r\n\r\n执行器 / 来源 / 模型 / 推理档位\r\n{S(execution,"executorId")} / {S(execution,"connectionId")} / {S(execution,"providerId")}\r\n{S(execution,"modelId")} / {S(execution,"reasoningEffort")}\r\n\r\n当前观察费率：{(unknown?"未知，可能计费":S(quote,"credits"))}\r\n最多 {S(contract,"maxAttempts")} 轮，时限 {S(contract,"timeoutSeconds")} 秒；时限不是费用上限。\r\n\r\n任务目标\r\n{S(contract,"objective")}\r\n\r\n允许修改范围（空范围为只读）\r\n{Items(scope.GetProperty("allowedChanges"))}\r\n\r\n允许的元数据\r\n{Items(scope.GetProperty("permittedMetadata"))}\r\n\r\n独立验收要求\r\n{string.Join("\r\n",contract.GetProperty("requiredChecks").EnumerateArray().Select(check=>S(check,"definition")))}\r\n\r\n任务编号：{S(draft,"taskId")}\r\n约定指纹：{S(draft,"digest")}";
        using var dialog = new Form { Text = "确认派工", Width = 760, Height = 720, MinimumSize = new Size(600, 500), StartPosition = FormStartPosition.CenterParent, MinimizeBox = false, MaximizeBox = false, BackColor = Color.FromArgb(243,246,248), Font = new Font("Microsoft YaHei UI", 10) };
        var text = new TextBox { Text = summary, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Color.White };
        var consent = new CheckBox { Text = unknown ? "我了解费率未知，可能产生费用" : "我已核对模型、费用信息与任务范围", AutoSize = true, Margin = new Padding(8) };
        var confirm = new Button { Text = "确认并派工", AutoSize = true, Enabled = false, DialogResult = DialogResult.OK, Padding = new Padding(8) };
        var cancel = new Button { Text = "返回核对", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(8) };
        consent.CheckedChanged += (_, _) => confirm.Enabled = consent.Checked;
        var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(12), WrapContents = true };
        footer.Controls.Add(consent); footer.SetFlowBreak(consent, true); footer.Controls.Add(confirm); footer.Controls.Add(cancel);
        var content = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20) }; content.Controls.Add(text);
        dialog.Controls.Add(content); dialog.Controls.Add(footer); dialog.CancelButton = cancel;
        dialog.Shown += (_, _) => { text.SelectionStart = 0; text.SelectionLength = 0; consent.Focus(); };
        // No default AcceptButton: Enter does not accidentally authorize cost.
        return dialog.ShowDialog(owner) == DialogResult.OK;
    }
}
