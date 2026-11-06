using System.Text;
using System.Text.Json;

namespace WorkBuddy.Workbench;

internal sealed record DesktopWebCommand(string Action, JsonElement Parameters);
internal static class DesktopControlPolicy
{
    public const int MaximumBodyBytes = 65536;
    public static bool IsRoute(Uri origin, string target, string path, string method, string expectedMethod)
        => method == expectedMethod && Uri.TryCreate(target, UriKind.Absolute, out var uri)
        && uri.Scheme == "http" && uri.Host == "127.0.0.1" && uri.Port == origin.Port
        && uri.UserInfo == "" && uri.AbsolutePath == path && uri.Query == "" && uri.Fragment == "";
    public static bool IsTrustedPage(Uri origin, string source)
        => Uri.TryCreate(source, UriKind.Absolute, out var uri) && uri.Scheme == "http" && uri.Host == "127.0.0.1"
        && uri.Port == origin.Port && uri.UserInfo == "" && uri.AbsolutePath == "/workbench/" && uri.Query == "";
    public static DesktopWebCommand Decode(string json)
    {
        if (Encoding.UTF8.GetByteCount(json) > MaximumBodyBytes) throw new ArgumentException("Desktop request is too large.");
        using var document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 12 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object || root.EnumerateObject().Count() != 2 || root.EnumerateObject().Any(p => p.Name is not ("action" or "parameters"))) throw new ArgumentException("Unexpected desktop request fields.");
        var action = root.GetProperty("action").GetString();
        if (action is not ("catalog" or "preview" or "dispatch" or "status" or "observe" or "choose_workspace" or "latest" or "control_preview" or "control" or "control_status" or "control_list" or "control_observe" or "control_requirements" or "recovery_show" or "attention_verify" or "declare_native_stop"
            or "productivity_catalog" or "productivity_template_detail" or "productivity_template_save" or "productivity_template_archive" or "productivity_notifications" or "productivity_notification_config" or "productivity_export_preview" or "productivity_export_save"))
            throw new ArgumentException("Unsupported desktop action.");
        var parameters = root.GetProperty("parameters");
        if (parameters.ValueKind != JsonValueKind.Object) throw new ArgumentException("Object parameters are required.");
        if (action is "catalog" or "choose_workspace" or "latest" && parameters.EnumerateObject().Any()) throw new ArgumentException("Action has no parameters.");
        if (action is "productivity_notifications" && parameters.EnumerateObject().Any()) throw new ArgumentException("Action has no parameters.");
        if (action == "productivity_catalog")
        {
            if (parameters.EnumerateObject().Any(p => p.Name != "includeArchived" || p.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                || parameters.EnumerateObject().Count() > 1) throw new ArgumentException("Only an archived switch is accepted.");
        }
        if (action is "productivity_template_detail" or "productivity_template_archive")
        {
            if (parameters.EnumerateObject().Count() != 1 || parameters.EnumerateObject().Any(p => p.Name != "templateId")
                || !IsTemplateId(parameters.GetProperty("templateId"))) throw new ArgumentException("A template identity is required.");
        }
        if (action == "productivity_template_save")
        {
            if (parameters.EnumerateObject().Count() is < 1 or > 2 || parameters.EnumerateObject().Any(p => p.Name is not ("template" or "templateId"))
                || !parameters.TryGetProperty("template", out var template) || template.ValueKind != JsonValueKind.Object
                || (parameters.TryGetProperty("templateId", out var named) && !IsTemplateId(named))) throw new ArgumentException("A template body is required.");
        }
        if (action == "productivity_notification_config")
        {
            if (parameters.EnumerateObject().Count() != 1 || parameters.EnumerateObject().Any(p => p.Name != "config")
                || !parameters.TryGetProperty("config", out var config) || config.ValueKind != JsonValueKind.Object) throw new ArgumentException("A notification configuration is required.");
        }
        if (action is "productivity_export_preview" or "productivity_export_save")
        {
            var allowed = action == "productivity_export_preview" ? new[] { "taskId" } : new[] { "taskId", "digest", "directory" };
            if (parameters.EnumerateObject().Any(p => !allowed.Contains(p.Name)) || !parameters.TryGetProperty("taskId", out var taskId) || !IsIdentity(taskId)) throw new ArgumentException("A task identity is required.");
            if (action == "productivity_export_save")
            {
                if (!parameters.TryGetProperty("digest", out var digest) || digest.ValueKind != JsonValueKind.String || digest.GetString() is not { Length: 64 } text || text.Any(c => !Uri.IsHexDigit(c))) throw new ArgumentException("A verified export digest is required.");
                if (parameters.TryGetProperty("directory", out var directory) && directory.ValueKind != JsonValueKind.String) throw new ArgumentException("A folder path must be text.");
            }
        }
        if (action == "dispatch")
        {
            if (parameters.EnumerateObject().Count() != 2 || parameters.EnumerateObject().Any(p => p.Name is not ("draftId" or "digest"))
                || !Guid.TryParseExact(parameters.GetProperty("draftId").GetString(), "D", out _)
                || parameters.GetProperty("digest").GetString() is not { Length: 64 } digest || digest.Any(c => !Uri.IsHexDigit(c))) throw new ArgumentException("A verified draft identity is required.");
        }
        if (action is "status" or "observe" && (parameters.EnumerateObject().Count() != 1 || !Guid.TryParseExact(parameters.GetProperty("requestId").GetString(), "D", out _))) throw new ArgumentException("An original request identity is required.");
        if (action == "control")
        {
            if (parameters.EnumerateObject().Count() != 2 || parameters.EnumerateObject().Any(p => p.Name is not ("requestId" or "digest"))
                || !Guid.TryParseExact(parameters.GetProperty("requestId").GetString(), "D", out _)
                || parameters.GetProperty("digest").GetString() is not { Length: 64 } digest || digest.Any(c => !Uri.IsHexDigit(c))) throw new ArgumentException("A verified control identity is required.");
        }
        if (action == "control_status" && (parameters.EnumerateObject().Count() != 1 || !Guid.TryParseExact(parameters.GetProperty("requestId").GetString(), "D", out _))) throw new ArgumentException("An original control identity is required.");
        if (action is "control_list" or "control_observe" && (parameters.EnumerateObject().Count() != 2 || parameters.EnumerateObject().Any(p => p.Name is not ("taskId" or "attemptId")) || parameters.GetProperty("taskId").GetString() is not { Length: > 0 and <= 200 } || parameters.GetProperty("attemptId").GetString() is not { Length: > 0 and <= 200 })) throw new ArgumentException("A task and attempt identity are required.");
        if (action == "control_requirements" && (parameters.EnumerateObject().Count() != 3 || parameters.EnumerateObject().Any(p => p.Name is not ("taskId" or "attemptId" or "revision")) || parameters.GetProperty("taskId").GetString() is not { Length: > 0 and <= 200 } || parameters.GetProperty("attemptId").GetString() is not { Length: > 0 and <= 200 } || parameters.GetProperty("revision").GetString() is not { Length: > 0 and <= 200 })) throw new ArgumentException("Current task, attempt and revision are required.");
        if (action == "recovery_show")
        {
            if (parameters.EnumerateObject().Count() != 1 || parameters.EnumerateObject().Any(p => p.Name is not "identity")) throw new ArgumentException("Unexpected recovery parameters.");
            var identity = parameters.GetProperty("identity").GetString();
            if (identity is not { Length: > 0 and <= 200 } || identity.Any(char.IsControl)) throw new ArgumentException("An operation or dispatch identity is required.");
        }
        if (action == "attention_verify")
        {
            if (parameters.EnumerateObject().Count() != 1 || parameters.EnumerateObject().Any(p => p.Name is not "taskId")) throw new ArgumentException("Unexpected attention parameters.");
            var taskId = parameters.GetProperty("taskId").GetString();
            if (taskId is not { Length: > 0 and <= 200 } || taskId.Any(char.IsControl)) throw new ArgumentException("A task identity is required.");
        }
        if (action == "declare_native_stop")
        {
            if (parameters.EnumerateObject().Count() != 5 || parameters.EnumerateObject().Any(p => p.Name is not ("taskId" or "attemptId" or "revision" or "statement" or "confirmation"))) throw new ArgumentException("Unexpected declaration parameters.");
            foreach (var name in new[] { "taskId", "attemptId", "revision" })
            {
                var value = parameters.GetProperty(name).GetString();
                if (value is not { Length: > 0 and <= 200 } || value.Any(char.IsControl)) throw new ArgumentException("A task, attempt and revision are required.");
            }
            var statement = parameters.GetProperty("statement").GetString();
            if (statement is not { Length: >= 10 and <= 2000 } || statement.Any(c => char.IsControl(c) && c is not ('\n' or '\t')))
                throw new ArgumentException("A bounded statement is required.");
            var expected = $"declare native stop {parameters.GetProperty("taskId").GetString()} {parameters.GetProperty("attemptId").GetString()} {parameters.GetProperty("revision").GetString()}";
            if (parameters.GetProperty("confirmation").GetString() != expected) throw new ArgumentException("The shown sentence must be typed exactly.");
        }
        return new DesktopWebCommand(action!, parameters.Clone());
    }
    // Identities are matched, never turned into paths: a template id has a fixed prefix and alphabet,
    // and a task id is a bounded string without control characters.
    private static bool IsTemplateId(JsonElement value)
        => value.ValueKind == JsonValueKind.String && value.GetString() is { } text
        && System.Text.RegularExpressions.Regex.IsMatch(text, "^tmpl-[A-Za-z0-9-]{8,64}$");
    private static bool IsIdentity(JsonElement value)
        => value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 and <= 200 } text && !text.Any(char.IsControl);
}
