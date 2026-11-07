using System.Text.Json;

namespace WorkBuddy.Workbench;

/// <summary>
/// The gateway's installed production dependencies as the preview shell sees them.
/// <para>
/// The preview package intentionally ships without <c>node_modules</c>: the shell therefore has to
/// name the directory that is missing and the command that installs it, instead of starting a host
/// that cannot import its own code and reporting a generic connection failure. A directory that
/// merely exists is not trusted — every declared production dependency must resolve to a real
/// <c>package.json</c>, and a linked <c>node_modules</c> is reported as its own problem.
/// </para>
/// </summary>
internal sealed record GatewayDependencies(string GatewayDirectory, string ModulesDirectory, IReadOnlyList<string> Missing, string? Problem)
{
    internal const string PreviewGuideFileName = "PREVIEW-START-HERE.md";
    private const int DisplayLimit = 5;

    internal bool Installed => Problem is null && Missing.Count == 0;

    /// <summary>The recovery entry points a preview package offers, in the order the guide lists them.</summary>
    internal string RecoveryCommand => "node scripts/bootstrap.mjs --install-root \"" + GatewayDirectory + "\"";

    internal string MissingSummary => Missing.Count switch
    {
        0 => "无缺失",
        <= DisplayLimit => string.Join("、", Missing),
        _ => string.Join("、", Missing.Take(DisplayLimit)) + " 等 " + Missing.Count + " 个"
    };

    /// <summary>What the window shows. It names the directory, the first missing package and both recovery entries.</summary>
    internal string OperatorMessage
    {
        get
        {
            var head = Problem ?? (Directory.Exists(ModulesDirectory)
                ? "网关依赖不完整：缺少 " + MissingSummary + "（目录 " + ModulesDirectory + "）。"
                : "网关依赖未安装：" + ModulesDirectory + " 不存在。");
            return head + "\r\n\r\n"
                + "恢复：在 " + GatewayDirectory + " 运行 " + RecoveryCommand + "，或运行 npm ci --omit=dev。完成后点“重新连接”。\r\n"
                + "详细步骤见包根的 " + GuidePath + "。";
        }
    }

    internal string GuidePath => Path.Combine(Path.GetDirectoryName(GatewayDirectory) ?? GatewayDirectory, PreviewGuideFileName);

    /// <summary>
    /// Reads the gateway manifest and checks each declared production dependency. Nothing is
    /// installed, created or written here; this is a read-only inspection of the extracted package.
    /// </summary>
    internal static GatewayDependencies Inspect(string gatewayDirectory)
    {
        var modules = Path.Combine(gatewayDirectory, "node_modules");
        var manifest = Path.Combine(gatewayDirectory, "package.json");
        if (!File.Exists(manifest)) return new(gatewayDirectory, modules, [], "网关目录不完整：缺少 " + manifest + "，请重新解压预览包。");
        string[] required;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(manifest));
            if (!document.RootElement.TryGetProperty("dependencies", out var dependencies) || dependencies.ValueKind != JsonValueKind.Object) required = [];
            else required = dependencies.EnumerateObject().Select(property => property.Name).Where(name => name.Length > 0).ToArray();
        }
        catch (JsonException) { return new(gatewayDirectory, modules, [], "网关 package.json 无法解析，请重新解压预览包。"); }
        if (required.Length == 0) return new(gatewayDirectory, modules, [], null);
        if (!Directory.Exists(modules)) return new(gatewayDirectory, modules, required, null);
        if (new DirectoryInfo(modules).Attributes.HasFlag(FileAttributes.ReparsePoint))
            return new(gatewayDirectory, modules, required, "node_modules 是目录联接或符号链接：" + modules + "。工作台只接受真实目录，请按说明实际安装依赖。");
        var missing = required.Where(name => !File.Exists(Path.Combine(modules, name.Replace('/', Path.DirectorySeparatorChar), "package.json"))).ToArray();
        return new(gatewayDirectory, modules, missing, null);
    }
}

/// <summary>A missing-dependency startup fault, kept apart from Node, WebView2 and host failures.</summary>
internal sealed class GatewayDependencyException(GatewayDependencies dependencies) : Exception(dependencies.OperatorMessage)
{
    internal GatewayDependencies Dependencies { get; } = dependencies;
}

/// <summary>A startup precondition fault with its own code, so each cause stays distinguishable in the status frame.</summary>
internal sealed class StartupFaultException(string code, string message) : Exception(message)
{
    internal string Code { get; } = code;
}
