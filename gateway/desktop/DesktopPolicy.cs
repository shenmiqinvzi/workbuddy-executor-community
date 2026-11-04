using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace WorkBuddy.Workbench;

internal sealed record DesktopOptions(string GatewayDirectory, string NodeExecutable, string Database, string RunsDirectory, string? TaskId, bool StatusOnly, IReadOnlyList<string> EmbedOrigins)
{
    public static DesktopOptions Parse(string[] args)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        var status = false;
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i] == "--status") { if (status) throw new ArgumentException("Duplicate status option."); status = true; continue; }
            var key = args[i];
            if (key is not ("--gateway-dir" or "--node" or "--database" or "--runs-dir" or "--task-id") || ++i >= args.Length || !values.TryAdd(key, args[i]))
                throw new ArgumentException("Invalid or duplicate desktop option.");
        }
        string Required(string key) => values.TryGetValue(key, out var value) && !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException("Missing desktop option: " + key);
        string Absolute(string key) { var value = Required(key); if (!Path.IsPathFullyQualified(value)) throw new ArgumentException("Desktop paths must be absolute."); return Path.GetFullPath(value); }
        var task = values.GetValueOrDefault("--task-id");
        if (task is not null && !ValidTaskId(task)) throw new ArgumentException("Invalid task identifier.");
        return new(Absolute("--gateway-dir").TrimEnd(Path.DirectorySeparatorChar), Absolute("--node"), Absolute("--database"), Absolute("--runs-dir"), task, status, ParseEmbedOrigins(Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_EMBED_ORIGINS"), Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_EMBED_URL")));
    }

    // Embedded panels are opt-in: with no configured origin the shell still cancels every sub-frame,
    // which is the default guard against a page embedding arbitrary local services. A configured
    // panel URL implies its own origin, so installing one variable is enough; extra origins remain
    // available for a panel that loads sibling services.
    public static IReadOnlyList<string> ParseEmbedOrigins(string? raw, string? panelUrl = null)
    {
        var result = new List<string>();
        if (!string.IsNullOrWhiteSpace(raw))
            foreach (var part in raw.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (!Uri.TryCreate(part, UriKind.Absolute, out var url)) throw new ArgumentException("Embed origins must be absolute loopback HTTP origins.");
                if (url.Scheme != "http" || (url.Host != "127.0.0.1" && url.Host != "localhost") || url.UserInfo != "" || url.AbsolutePath != "/" || url.Query != "" || url.Fragment != "")
                    throw new ArgumentException("Embed origins must be loopback HTTP origins without a path.");
                var authority = url.GetLeftPart(UriPartial.Authority);
                if (!result.Contains(authority)) result.Add(authority);
            }
        // A panel URL may carry a path; only its origin is taken, and only when the URL itself is
        // already a usable loopback HTTP page, so a stray value cannot widen the frame policy.
        if (!string.IsNullOrWhiteSpace(panelUrl) && Uri.TryCreate(panelUrl, UriKind.Absolute, out var panel)
            && panel.Scheme == "http" && (panel.Host == "127.0.0.1" || panel.Host == "localhost")
            && panel.UserInfo == "" && panel.Query == "" && panel.Fragment == "")
        {
            var origin = panel.GetLeftPart(UriPartial.Authority);
            if (!result.Contains(origin)) result.Add(origin);
        }
        return result;
    }

    public string InstanceKey => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(GatewayDirectory.ToUpperInvariant() + "\n" + Database.ToUpperInvariant() + "\n" + RunsDirectory.ToUpperInvariant())))[..24];
    public string PipeName => "WorkBuddy.Workbench." + InstanceKey;
    public string ProfileDirectory
    {
        get
        {
            var root = Environment.GetEnvironmentVariable("WORKBUDDY_WORKBENCH_PROFILE_ROOT");
            if (string.IsNullOrWhiteSpace(root)) root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WorkBuddyWorkbench");
            if (!Path.IsPathFullyQualified(root)) throw new ArgumentException("Desktop profile root must be absolute.");
            return Path.Combine(root, InstanceKey, "WebView2");
        }
    }
    public static bool ValidTaskId(string value) => value.Length is > 0 and <= 200 && !value.Any(c => char.IsControl(c) || c is '/' or '\\' || char.IsSurrogate(c));
    public static string? DecodeTaskMessage(string message)
    {
        if (Encoding.UTF8.GetByteCount(message) > 1024) throw new ArgumentException("Desktop message too large.");
        using var doc = JsonDocument.Parse(message);
        if (doc.RootElement.ValueKind != JsonValueKind.Object || doc.RootElement.EnumerateObject().Any(p => p.Name is not ("taskId" or "status"))) throw new ArgumentException("Invalid desktop message.");
        var task = doc.RootElement.TryGetProperty("taskId", out var t) && t.ValueKind != JsonValueKind.Null ? t.GetString() : null;
        if (task is not null && !ValidTaskId(task)) throw new ArgumentException("Invalid task identifier.");
        return task;
    }
    public static bool AllowedRequest(Uri origin, string target, string method)
        => method is "GET" or "HEAD" && Uri.TryCreate(target, UriKind.Absolute, out var url)
           && url.Scheme == "http" && url.Host == "127.0.0.1" && url.Port == origin.Port && url.UserInfo == ""
           && url.AbsolutePath.StartsWith("/workbench/", StringComparison.Ordinal);
    // Only an explicitly configured loopback authority may load inside a sub-frame, and only with
    // the methods a read-only local dashboard needs. Everything else stays cancelled.
    public bool AllowsEmbed(string target, string method)
        => EmbedOrigins.Count > 0 && method is "GET" or "HEAD" or "POST"
           && Uri.TryCreate(target, UriKind.Absolute, out var url)
           && url.Scheme == "http" && url.UserInfo == ""
           && EmbedOrigins.Contains(url.GetLeftPart(UriPartial.Authority));
    public static Uri PageUri(Uri origin, string? taskId) => new(origin, "/workbench/" + (taskId is null ? "" : "#taskId=" + Uri.EscapeDataString(taskId)));
}
