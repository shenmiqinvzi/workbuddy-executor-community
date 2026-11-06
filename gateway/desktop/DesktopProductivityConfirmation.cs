using System.Text.Json;

namespace WorkBuddy.Workbench;

/// <summary>
/// Native confirmations for the two local writes this build owns: saving a project template and
/// writing a redacted delivery export. Both dialogs show what will be written and require an
/// explicit checkbox; closing the dialog cancels without touching the task record.
/// </summary>
internal static class DesktopProductivityConfirmation
{
    public static bool Show(IWin32Window owner, string title, string summary, string consentText, string confirmText)
    {
        using var dialog = new Form
        {
            Text = title,
            Width = 720,
            Height = 560,
            MinimumSize = new Size(560, 420),
            StartPosition = FormStartPosition.CenterParent,
            MinimizeBox = false,
            MaximizeBox = false,
            BackColor = Color.FromArgb(243, 246, 248),
            Font = new Font("Microsoft YaHei UI", 10),
        };
        var text = new TextBox { Text = summary, Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Vertical, Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Color.White };
        var consent = new CheckBox { Text = consentText, AutoSize = true, Margin = new Padding(8) };
        var confirm = new Button { Text = confirmText, AutoSize = true, Enabled = false, DialogResult = DialogResult.OK, Padding = new Padding(8) };
        var cancel = new Button { Text = "返回", AutoSize = true, DialogResult = DialogResult.Cancel, Padding = new Padding(8) };
        consent.CheckedChanged += (_, _) => confirm.Enabled = consent.Checked;
        var footer = new FlowLayoutPanel { Dock = DockStyle.Bottom, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, FlowDirection = FlowDirection.LeftToRight, Padding = new Padding(12), WrapContents = true };
        footer.Controls.Add(consent);
        footer.SetFlowBreak(consent, true);
        footer.Controls.Add(confirm);
        footer.Controls.Add(cancel);
        var content = new Panel { Dock = DockStyle.Fill, Padding = new Padding(20) };
        content.Controls.Add(text);
        dialog.Controls.Add(content);
        dialog.Controls.Add(footer);
        dialog.CancelButton = cancel;
        // No default AcceptButton: Enter must not save anything by accident.
        dialog.Shown += (_, _) => { text.SelectionStart = 0; text.SelectionLength = 0; consent.Focus(); };
        return dialog.ShowDialog(owner) == DialogResult.OK;
    }

    public static bool ShowExportSave(IWin32Window owner, JsonElement parameters, string directory)
    {
        var taskId = parameters.GetProperty("taskId").GetString();
        var digest = parameters.GetProperty("digest").GetString();
        var summary = "将把当前任务的脱敏导出写入你选定的文件夹。\r\n\r\n"
            + $"文件夹\r\n{directory}\r\n\r\n"
            + $"任务编号：{taskId}\r\n预览指纹：{digest}\r\n\r\n"
            + "导出只包含字段白名单里的快照：任务结论、契约要点、证据类型、统计覆盖与已知限制。"
            + "不包含凭据、账号、聊天正文、原生日志或数据库，也不会按路径读取任何本机文件。\r\n\r\n"
            + "如果任务在预览之后发生变化，本次保存会取消，不会留下半份文件；同名文件不会被覆盖。";
        return Show(owner, "保存脱敏导出", summary, "我已核对文件夹与预览指纹", "保存导出");
    }

    public static bool ShowTemplateSave(IWin32Window owner, JsonElement parameters)
    {
        var template = parameters.GetProperty("template");
        string Text(string name) => template.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() ?? "未提供" : "未提供";
        static int Count(JsonElement template, string name) => template.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Array ? value.GetArrayLength() : 0;
        var checks = template.TryGetProperty("project", out var project) ? Count(project, "requiredChecks") : 0;
        var scope = template.TryGetProperty("project", out var preset) ? Count(preset, "allowedChanges") : 0;
        var policy = Text("kind") == "policy-suggestion";
        var named = parameters.TryGetProperty("templateId", out var id) ? id.GetString() : null;
        var summary = $"名称\r\n{Text("name")}\r\n\r\n"
            + $"类型\r\n{(policy ? "政策建议（只保存建议，不激活）" : "手动模板")}\r\n\r\n"
            + $"版本说明\r\n{Text("description")}\r\n\r\n"
            + $"检查定义：{checks} 项\r\n允许修改范围：{scope} 项\r\n超时：{Text("timeoutSeconds")} 秒\r\n最多轮次：{Text("maxAttempts")}\r\n\r\n"
            + $"模板编号：{named ?? "将新建编号"}\r\n\r\n"
            + "模板只保存预设与检查定义，不携带任务编号、操作编号、旧证据或旧授权；"
            + "实例化时会重新生成身份和预算，命令与路径仍按真实范围复核。"
            + (policy ? "\r\n\r\n本版本的自动政策引擎未交付：该模板只能作为建议保存，实例化会被拒绝。" : string.Empty);
        return Show(owner, "保存项目模板", summary, "我已核对模板内容与检查定义", "保存模板");
    }
}
