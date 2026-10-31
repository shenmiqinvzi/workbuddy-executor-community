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
        if (action is not ("catalog" or "preview" or "dispatch" or "status" or "observe" or "choose_workspace" or "latest" or "control_preview" or "control" or "control_status" or "control_list" or "control_observe" or "control_requirements")) throw new ArgumentException("Unsupported desktop action.");
        var parameters = root.GetProperty("parameters");
        if (parameters.ValueKind != JsonValueKind.Object) throw new ArgumentException("Object parameters are required.");
        if (action is "catalog" or "choose_workspace" or "latest" && parameters.EnumerateObject().Any()) throw new ArgumentException("Action has no parameters.");
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
        return new DesktopWebCommand(action!, parameters.Clone());
    }
}
