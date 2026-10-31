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

internal static class DesktopControlConfirmation
{
    public static bool Show(IWin32Window owner, JsonElement preview)
    {
        var draft=preview.GetProperty("draft"); var snapshot=preview.GetProperty("snapshot");
        var parameters=draft.GetProperty("parameters"); var kind=draft.GetProperty("kind").GetString();
        string S(JsonElement element,string name) => element.TryGetProperty(name,out var field) && field.ValueKind is not (JsonValueKind.Null or JsonValueKind.Undefined) ? field.ToString() : "未提供";
        string Status(string status)=>status switch {"passed"=>"通过","failed"=>"未通过","unknown"=>"无法判断",_=>"未知"};
        string Kind(string value)=>value switch {"command"=>"原约定命令","semantic"=>"语义要求",_=>"未知要求"};
        var title=kind switch { "cancel"=>"确认停止任务", "rework"=>"确认提交返工", "review"=>"确认独立审查", "accept"=>"确认最终验收", _=>throw new ArgumentException("Unsupported control.") };
        var details=kind switch
        {
            "cancel"=>"此操作会请求停止当前轮次。取消是终态；请求已提交不代表原生执行已停止。",
            "rework"=>$"修改要求\r\n{S(parameters,"feedback")}\r\n\r\n执行器 / 来源\r\n{S(snapshot,"executorId")} / {S(snapshot,"connectionId")} / {S(snapshot,"providerId")}\r\n模型 / 推理档位\r\n{S(snapshot,"model")} / {S(snapshot,"reasoningEffort")}\r\n观察费率：{(snapshot.GetProperty("rate").ValueKind == JsonValueKind.Null ? "未知，可能计费" : S(snapshot,"rate"))}\r\n当前第 {S(snapshot,"attempt")} 轮，最多 {S(snapshot,"attemptLimit")} 轮。",
            "review"=>$"实际检查说明\r\n{S(parameters,"feedback")}\r\n\r\n已检查的项目文件\r\n{string.Join("\r\n",parameters.GetProperty("inspectionFiles").EnumerateArray().Select(file=>"  "+file.ToString()))}\r\n\r\n原始验收要求（含将执行的原约定命令）\r\n{string.Join("\r\n",snapshot.GetProperty("requirements").EnumerateArray().Select(check=>$"  [{Kind(S(check,"kind"))}] {S(check,"id")}: {S(check,"definition")}"))}\r\n\r\n你的逐项判断\r\n{string.Join("\r\n",parameters.GetProperty("semanticChecks").EnumerateArray().Select(check=>$"  {S(check,"checkId")}: {Status(S(check,"status"))}"))}\r\n\r\n请确认已独立检查所列文件；执行器的自报不代替独立审查。",
            "accept"=>$"将验收当前已保存的独立审查记录。\r\n审查编号：{S(parameters,"reviewId")}\r\n系统会再次核对原生停止、检查与当前文件证据。",
            _=>throw new ArgumentException("Unsupported control.")
        };
        var summary=$"{S(snapshot,"title")}\r\n\r\n项目\r\n{S(snapshot,"workspace")}\r\n\r\n{details}\r\n\r\n任务编号：{S(draft,"taskId")}\r\n当前轮次：{S(draft,"attemptId")}";
        using var dialog=new Form {Text=title,Width=720,Height=610,MinimumSize=new Size(560,440),StartPosition=FormStartPosition.CenterParent,MinimizeBox=false,MaximizeBox=false,BackColor=Color.FromArgb(243,246,248),Font=new Font("Microsoft YaHei UI",10)};
        var text=new TextBox {Text=summary,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,Dock=DockStyle.Fill,BorderStyle=BorderStyle.None,BackColor=Color.White};
        var consent=new CheckBox {Text=kind switch {"cancel"=>"我了解取消将结束此任务","rework"=>"我已核对来源、模型与费率信息","review"=>"我已独立检查所列文件并确认逐项判断",_=>"我已核对当前独立审查结果"},AutoSize=true,Margin=new Padding(8)};
        var confirm=new Button {Text=kind switch {"cancel"=>"请求停止","rework"=>"确认返工","review"=>"执行独立审查",_=>"确认验收"},AutoSize=true,Enabled=false,DialogResult=DialogResult.OK,Padding=new Padding(8)};
        var cancel=new Button {Text="返回",AutoSize=true,DialogResult=DialogResult.Cancel,Padding=new Padding(8)};
        consent.CheckedChanged+=(_,_)=>confirm.Enabled=consent.Checked;
        var footer=new FlowLayoutPanel {Dock=DockStyle.Bottom,AutoSize=true,AutoSizeMode=AutoSizeMode.GrowAndShrink,FlowDirection=FlowDirection.LeftToRight,Padding=new Padding(12),WrapContents=true};
        footer.Controls.Add(consent);footer.SetFlowBreak(consent,true);footer.Controls.Add(confirm);footer.Controls.Add(cancel);
        var content=new Panel {Dock=DockStyle.Fill,Padding=new Padding(20)};content.Controls.Add(text);
        dialog.Controls.Add(content);dialog.Controls.Add(footer);dialog.CancelButton=cancel;
        dialog.Shown+=(_,_)=>{text.SelectionStart=0;text.SelectionLength=0;consent.Focus();};
        return dialog.ShowDialog(owner)==DialogResult.OK;
    }
}
