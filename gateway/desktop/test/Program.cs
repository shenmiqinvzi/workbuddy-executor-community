using WorkBuddy.Workbench;

var passed = 0;
void Check(bool condition, string text) { if (!condition) throw new Exception(text); passed++; Console.WriteLine("PASS " + text); }
void Reject(Action action, string text) { try { action(); } catch { Check(true, text); return; } throw new Exception("Expected rejection: " + text); }
string[] Args(string database = "C:\\work with spaces\\tasks.sqlite") => ["--gateway-dir", "C:\\work with spaces\\gateway", "--node", "C:\\node.exe", "--database", database, "--runs-dir", "C:\\runs"];
var options = DesktopOptions.Parse([..Args(), "--task-id", "task <&中文>"]);
Check(options.TaskId == "task <&中文>", "task identity remains data");
Check(options.InstanceKey == DesktopOptions.Parse(Args()).InstanceKey, "task identity does not create another window");
Check(options.InstanceKey != DesktopOptions.Parse(Args("C:\\other.sqlite")).InstanceKey, "separate stores have separate windows");
var differentRuns = Args(); differentRuns[^1] = "C:\\other-runs";
Check(options.InstanceKey != DesktopOptions.Parse(differentRuns).InstanceKey, "separate evidence directories have separate windows");
Check(options.InstanceKey == DesktopOptions.Parse(Args("c:\\WORK WITH SPACES\\TASKS.SQLITE")).InstanceKey, "Windows path case is canonical");
Reject(() => DesktopOptions.Parse([..Args(), "--url", "https://example.com"]), "arbitrary URLs are not options");
Reject(() => DesktopOptions.Parse([..Args(), "--task-id", "../file"]), "task paths rejected");
Reject(() => DesktopOptions.Parse([..Args(), "--task-id", "bad\nline"]), "task control characters rejected");
Reject(() => DesktopOptions.Parse([..Args(), "--task-id", new string('x',201)]), "oversized task identity rejected");
Reject(() => DesktopOptions.Parse([..Args(), "--node", "another.exe"]), "duplicate executable option rejected");
Check(DesktopOptions.DecodeTaskMessage("{\"taskId\":\"task & <x>\"}") == "task & <x>", "IPC task remains data");
Reject(() => DesktopOptions.DecodeTaskMessage("{\"command\":\"delete\"}"), "IPC exposes no commands");
Reject(() => DesktopOptions.DecodeTaskMessage(new string('x',1025)), "bounded IPC parser");
var origin = new Uri("http://127.0.0.1:49152");
Check(DesktopOptions.AllowedRequest(origin, "http://127.0.0.1:49152/workbench/app.mjs", "GET"), "local asset GET allowed");
Check(!DesktopOptions.AllowedRequest(origin, "http://127.0.0.1:49153/workbench/", "GET"), "another local service blocked");
Check(!DesktopOptions.AllowedRequest(origin, "http://127.0.0.1:49152/workbench/", "POST"), "write requests blocked");
Check(!DesktopOptions.AllowedRequest(origin, "https://example.com/workbench/", "GET"), "external network blocked");
Check(!DesktopOptions.AllowedRequest(origin, "file:///C:/workbench/", "GET"), "local filesystem navigation blocked");
Check(!DesktopOptions.AllowedRequest(origin, "http://127.0.0.1:49152/other", "GET"), "unrelated local paths blocked");
Check(DesktopOptions.PageUri(origin,"task <&中文>").Fragment.StartsWith("#taskId=task%20%3C%26"), "task link escapes identity");
Check(options.EmbedOrigins.Count == 0 && !options.AllowsEmbed("http://127.0.0.1:3000/", "GET"), "sub-frames stay cancelled without an opt-in origin");
var embedOptions = options with { EmbedOrigins = DesktopOptions.ParseEmbedOrigins("http://127.0.0.1:3000") };
Check(embedOptions.AllowsEmbed("http://127.0.0.1:3000/index.html", "GET"), "an opt-in loopback origin may load as a panel");
Check(embedOptions.AllowsEmbed("http://127.0.0.1:3000/api/login", "POST"), "a panel may post to its own origin");
Check(!embedOptions.AllowsEmbed("http://127.0.0.1:3001/", "GET"), "an opt-in origin does not cover another port");
Check(!embedOptions.AllowsEmbed("https://127.0.0.1:3000/", "GET"), "an opt-in origin stays plain HTTP");
Check(!embedOptions.AllowsEmbed("http://127.0.0.1:3000/", "DELETE"), "a panel cannot delete through the shell");
Check(!embedOptions.AllowsEmbed("http://example.com/", "GET"), "an opt-in origin cannot widen to the network");
Check(!embedOptions.AllowsEmbed("http://user@127.0.0.1:3000/", "GET"), "an opt-in origin rejects credentials");
Check(DesktopOptions.ParseEmbedOrigins(" http://127.0.0.1:3000 , http://127.0.0.1:3000 ").Count == 1, "duplicate embed origins collapse");
Reject(() => DesktopOptions.ParseEmbedOrigins("http://127.0.0.1:3000/dash"), "an embed origin carries no path");
Reject(() => DesktopOptions.ParseEmbedOrigins("https://127.0.0.1:3000"), "an embed origin must be plain HTTP");
Reject(() => DesktopOptions.ParseEmbedOrigins("http://10.0.0.5:3000"), "an embed origin must stay loopback");
var panelOptions = options with { EmbedOrigins = DesktopOptions.ParseEmbedOrigins(null, "http://127.0.0.1:3000/dash") };
Check(panelOptions.AllowsEmbed("http://127.0.0.1:3000/index.html", "GET"), "a panel URL alone opts its origin in");
Check(panelOptions.EmbedOrigins.Count == 1, "a panel URL adds exactly one origin");
Check(DesktopOptions.ParseEmbedOrigins("http://127.0.0.1:3000", "http://127.0.0.1:3000/dash").Count == 1, "a panel URL does not duplicate a listed origin");
Check(DesktopOptions.ParseEmbedOrigins(null, "https://127.0.0.1:3000/dash").Count == 0, "a non-http panel URL opts nothing in");
Check(DesktopOptions.ParseEmbedOrigins(null, "http://10.0.0.5:3000/dash").Count == 0, "a non-loopback panel URL opts nothing in");
Check(DesktopOptions.ParseEmbedOrigins(null, "nonsense").Count == 0, "an unparsable panel URL opts nothing in");
Check(DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49152/workbench/desktop/command","/workbench/desktop/command","POST","POST"), "exact native command interception route");
Check(!DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49153/workbench/desktop/command","/workbench/desktop/command","POST","POST"), "native control rejects another port");
Check(!DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49152/workbench/desktop/command?extra=1","/workbench/desktop/command","POST","POST"), "native control rejects query aliases");
Check(DesktopControlPolicy.IsTrustedPage(origin,"http://127.0.0.1:49152/workbench/#taskId=test"), "only the main document is a trusted control surface");
Check(!DesktopControlPolicy.IsTrustedPage(origin,"http://127.0.0.1:49152/workbench/app.mjs"), "asset documents cannot call native control");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"commit\",\"parameters\":{}}"), "page cannot directly commit backend drafts");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"control_commit\",\"parameters\":{}}"), "page cannot directly commit a control draft");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"control\",\"parameters\":{\"requestId\":\"11111111-1111-1111-1111-111111111111\",\"digest\":\""+new string('a',64)+"\",\"feedback\":\"replacement\"}}"), "control confirmation cannot replace frozen terms");
Check(DesktopControlPolicy.Decode("{\"action\":\"control\",\"parameters\":{\"requestId\":\"11111111-1111-1111-1111-111111111111\",\"digest\":\""+new string('a',64)+"\"}}").Action=="control", "control uses native confirmation with frozen identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"control_requirements\",\"parameters\":{\"taskId\":\"task\",\"attemptId\":\"run\",\"revision\":\"r\",\"command\":\"unexpected\"}}"), "requirements query refuses arbitrary fields");
Check(DesktopControlPolicy.Decode("{\"action\":\"control_requirements\",\"parameters\":{\"taskId\":\"task\",\"attemptId\":\"run\",\"revision\":\"r\"}}").Action=="control_requirements", "requirements query binds current task identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recovery_show\",\"parameters\":{}}"), "recovery evidence requires an identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recovery_show\",\"parameters\":{\"identity\":\"op\",\"confirm\":true}}"), "recovery evidence refuses extra fields");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recovery_show\",\"parameters\":{\"identity\":\"bad\\nline\"}}"), "recovery evidence refuses control characters");
Check(DesktopControlPolicy.Decode("{\"action\":\"recovery_show\",\"parameters\":{\"identity\":\"desktop-send-1\"}}").Action=="recovery_show", "recovery evidence is a desktop read that carries only an identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"attention_verify\",\"parameters\":{}}"), "pending-item verification requires a task identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"attention_verify\",\"parameters\":{\"taskId\":\"task\",\"retry\":true}}"), "pending-item verification refuses extra fields and cannot retry");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"attention_verify\",\"parameters\":{\"taskId\":\"bad\\nline\"}}"), "pending-item verification refuses control characters");
Check(DesktopControlPolicy.Decode("{\"action\":\"attention_verify\",\"parameters\":{\"taskId\":\"desktop-task-1\"}}").Action=="attention_verify", "pending-item verification is a desktop read that carries only a task identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"i checked the executor window\",\"confirmation\":\"yes\"}}"), "a stop declaration needs the exact sentence the page showed");
Check(DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"i checked the executor window\",\"confirmation\":\"declare native stop task-1 run-1 rev-1\"}}").Action=="declare_native_stop", "a stop declaration carries only its identity and the typed sentence");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"i checked the executor window\",\"confirmation\":\"declare native stop task-1 run-1 rev-1\",\"release\":true}}"), "a stop declaration refuses extra fields");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"short\",\"confirmation\":\"declare native stop task-1 run-1 rev-1\"}}"), "a stop declaration refuses a thin statement");
        Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"i checked \\u0007 the executor window\",\"confirmation\":\"declare native stop task-1 run-1 rev-1\"}}"), "a stop statement refuses control characters");
        Check(DesktopControlPolicy.Decode("{\"action\":\"declare_native_stop\",\"parameters\":{\"taskId\":\"task-1\",\"attemptId\":\"run-1\",\"revision\":\"rev-1\",\"statement\":\"first line\\nsecond line\",\"confirmation\":\"declare native stop task-1 run-1 rev-1\"}}").Action=="declare_native_stop", "a statement may still run over two lines");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"cancel\",\"parameters\":{}}"), "page cannot cancel or accept tasks");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"catalog\",\"parameters\":{},\"command\":\"bad\"}"), "unknown native fields rejected");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"dispatch\",\"parameters\":{\"model\":\"different\"}}"), "dispatch body cannot replace reviewed terms");
Reject(()=>DesktopControlPolicy.Decode(new string('x',65537)), "native request has a byte bound");
Check(DesktopControlPolicy.Decode("{\"action\":\"catalog\",\"parameters\":{}}").Action=="catalog", "catalog action remains explicit");
Check(DesktopControlPolicy.Decode("{\"action\":\"dispatch\",\"parameters\":{\"draftId\":\"11111111-1111-1111-1111-111111111111\",\"digest\":\""+new string('a',64)+"\"}}").Action=="dispatch", "page dispatch references an immutable draft only");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_catalog\",\"parameters\":{\"includeArchived\":true}}").Action=="productivity_catalog", "template catalog accepts an archived switch");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_catalog\",\"parameters\":{\"includeArchived\":\"yes\"}}"), "template catalog refuses a loose archived switch");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_notifications\",\"parameters\":{\"retry\":true}}"), "notification snapshot has no parameters and cannot retry");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_template_detail\",\"parameters\":{\"templateId\":\"tmpl-1234abcd\"}}").Action=="productivity_template_detail", "template detail accepts a template identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_template_detail\",\"parameters\":{\"templateId\":\"../../etc/passwd\"}}"), "template detail cannot read a path");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_template_archive\",\"parameters\":{\"templateId\":\"tmpl-1234abcd\",\"hard\":true}}"), "template archive refuses extra fields");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_template_save\",\"parameters\":{\"template\":{\"name\":\"draft\"}}}").Action=="productivity_template_save", "template save carries a body for native confirmation");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_template_save\",\"parameters\":{\"template\":{\"name\":\"draft\"},\"activate\":true}}"), "template save cannot ask for activation");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_template_save\",\"parameters\":{\"template\":\"not an object\"}}"), "template save needs an object body");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_template_save\",\"parameters\":{\"template\":{\"name\":\"draft\"},\"templateId\":\"tmpl-short\"}}"), "template save refuses a malformed identity");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_export_preview\",\"parameters\":{\"taskId\":\"task-1\"}}").Action=="productivity_export_preview", "export preview binds a task identity");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_export_preview\",\"parameters\":{\"taskId\":\"bad\\nline\"}}"), "export preview refuses control characters");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_export_save\",\"parameters\":{\"taskId\":\"task-1\",\"digest\":\""+new string('b',64)+"\"}}").Action=="productivity_export_save", "export save requires the preview digest");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_export_save\",\"parameters\":{\"taskId\":\"task-1\",\"digest\":\"short\"}}"), "export save refuses a short digest");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_export_save\",\"parameters\":{\"taskId\":\"task-1\",\"digest\":\""+new string('b',64)+"\",\"path\":\"C:\\\\Windows\"}}"), "export save takes a folder, never a file path");
Check(DesktopControlPolicy.Decode("{\"action\":\"productivity_notification_config\",\"parameters\":{\"config\":{\"enabled\":false}}}").Action=="productivity_notification_config", "notification switches are explicit fields");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"productivity_notification_config\",\"parameters\":{\"config\":\"off\"}}"), "notification switches need an object");
Check(DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"intent\":{\"title\":\"t\"},\"constraints\":{\"freeOnly\":true},\"resources\":[{\"sourceId\":\"s\"}],\"previous\":{\"digest\":\"d\"},\"statistics\":{}}}").Action=="recommend", "a recommendation reads the catalog with a bounded request shape");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"constraints\":{}}}"), "a recommendation needs an intent");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"intent\":{\"title\":\"t\"},\"selection\":{}}}"), "a recommendation refuses fields outside intent, constraints, statistics, resources and previous");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"intent\":{\"title\":\"t\"},\"resources\":{}}}"), "recommendation resources must be a list");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"recommend\",\"parameters\":{\"intent\":\"dispatch now\"}}"), "a recommendation intent must be an object");
var start = DesktopCommandChannel.StartInfo(Environment.GetEnvironmentVariable("WORKBUDDY_NODE_BIN") ?? "node", Environment.CurrentDirectory);
start.ArgumentList.Add("--input-type=module"); start.ArgumentList.Add("-e");
start.ArgumentList.Add("import readline from 'node:readline';const r=readline.createInterface({input:process.stdin});for await(const l of r){const m=JSON.parse(l);console.log(JSON.stringify({event:'desktop_command_result',id:m.id,ok:true,value:{message:'未知费率，可能计费',echo:m.parameters.text}}));}");
using (var child = System.Diagnostics.Process.Start(start)!)
{
    using var channel = new DesktopCommandChannel(child);
    var reply = await channel.CallAsync("synthetic", System.Text.Json.JsonSerializer.SerializeToElement(new { text = "项目路径与范围" }));
    Check(reply.GetProperty("message").GetString() == "未知费率，可能计费" && reply.GetProperty("echo").GetString() == "项目路径与范围", "private child channel preserves UTF-8 Chinese in both directions");
    child.StandardInput.Close();
    await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(5));
}
// --- Startup stages, bounds and host ownership ----------------------------------------------
// These doubles exercise the stage machine without a desktop session: no WebView2 environment is
// created, no host process is started, and no profile is touched.
var syntheticNow = 0L;
var episode = new StartupProgress(() => syntheticNow);
Check(episode.TryBegin(), "the first startup episode is claimed");
Check(!episode.TryBegin(), "a retry pressed during an episode starts nothing");
Check(episode.Outcome == StartupOutcome.Starting, "a claimed episode reports starting, not ready");
episode.End();
Check(episode.TryBegin(), "an episode can be claimed again after it ends");
StartupStep.Run(episode, "runtime", () => syntheticNow += 17);
StartupStep.Run(episode, "host", () => syntheticNow += 1000);
StartupStep.Run(episode, "profile", () => syntheticNow += 40);
var hangs = new TaskCompletionSource<object?>();
var expired = (StartupStepTimeoutException?)null;
var lifetime = new CancellationTokenSource();
try { await StartupStep.RunAsync(episode, "host_ready", 50, _ => hangs.Task, lifetime.Token); }
catch (StartupStepTimeoutException error) { expired = error; }
Check(expired is { BoundMs: 50 } && expired.Stage == "host_ready", "an expired bound names the stage and its budget");
Check(episode.Outcome == StartupOutcome.TimedOut, "an expired bound is a timeout, not a cancellation");
Check(episode.FailureCode == "timeout:host_ready", "the timeout keeps its stage in the failure code");
Check(episode.Stage == "host_ready", "the stage that hung stays current instead of advancing");
Check(!episode.FailureCode!.Contains("cancel", StringComparison.OrdinalIgnoreCase), "a timeout is not reported as cancelled");
Check(episode.FailureCode != "stopped" && !episode.FailureDetail!.Contains("stopped"), "a timeout is not reported as stopped");
Check(episode.Transitions.Select(item => item.Stage).SequenceEqual(["runtime", "host", "profile", "host_ready"]), "stages keep their entered order");
Check(episode.Transitions[1].ElapsedMs == 17 && episode.Transitions[2].ElapsedMs == 1017 && episode.Transitions[3].ElapsedMs == 1057, "each stage records when it was entered");
Check(episode.Transitions[3].BoundMs == 50, "the step that hung carries its own bound");

var waiting = new StartupProgress(() => syntheticNow);
syntheticNow = 0;
waiting.TryBegin();
waiting.Enter("webview");
waiting.Await("webview_environment", StartupProgress.WebViewEnvironmentBudgetMs);
syntheticNow += 33_000;
var pending = System.Text.Json.JsonSerializer.Serialize(waiting.Describe());
Check(pending.Contains("\"awaitingStage\":\"webview_environment\"", StringComparison.Ordinal), "a status read during a hang names the awaited stage");
Check(pending.Contains("\"awaitingMs\":33000", StringComparison.Ordinal), "the reported wait keeps growing while the step hangs");
Check(pending.Contains("\"awaitingBoundedMs\":30000", StringComparison.Ordinal), "the bound is reported beside the wait");
Check(pending.Contains("\"outcome\":\"starting\"", StringComparison.Ordinal), "a pending step is not reported as failed or stopped");
Check(StartupProgress.WebViewEnvironmentBudgetMs == 30_000 && StartupProgress.ControllerBudgetMs == 30_000, "the environment and the controller have separate, explicit bounds");

var selfCancelled = new StartupProgress();
selfCancelled.TryBegin();
var openWindow = new CancellationTokenSource();
var interrupted = (StartupStepTimeoutException?)null;
try { await StartupStep.RunAsync(selfCancelled, "controller", 5_000, _ => Task.FromException<int>(new OperationCanceledException("synthetic self cancel")), openWindow.Token); }
catch (StartupStepTimeoutException error) { interrupted = error; }
Check(interrupted?.Stage == "controller", "a step cancelling itself is recorded against its stage");
Check(selfCancelled.Outcome == StartupOutcome.Interrupted, "a self-cancelled step is an interruption, not the operator stopping the shell");
Check(selfCancelled.FailureCode == "interrupted:controller" && selfCancelled.FailureCode != "timeout:controller", "an interruption is distinct from an expired bound");
Check(!selfCancelled.FailureCode!.Contains("stopped", StringComparison.OrdinalIgnoreCase), "an interruption is not reported as stopped");

var closedWindow = new StartupProgress();
closedWindow.TryBegin();
var shut = new CancellationTokenSource(); shut.Cancel();
var closedByOperator = false;
try { await StartupStep.RunAsync(closedWindow, "controller", 5_000, Park, shut.Token); }
catch (OperationCanceledException) { closedByOperator = true; }
Check(closedByOperator && closedWindow.Outcome == StartupOutcome.Closed, "closing the window is recorded as closed");
Check(closedWindow.FailureCode is null, "a closed window is not given a failure code");
Check(System.Text.Json.JsonSerializer.Serialize(closedWindow.Describe()).Contains("\"outcome\":\"closed\"", StringComparison.Ordinal), "the snapshot reports the closed outcome");

var finished = new StartupProgress();
finished.TryBegin(); finished.Ready(); finished.End();
Check(finished.Outcome == StartupOutcome.Ready, "finishing an episode does not erase a ready outcome");
var retried = new StartupProgress();
retried.TryBegin(); retried.TimeOut("navigate", StartupProgress.NavigationBudgetMs, "synthetic"); retried.End();
Check(retried.TryBegin() && retried.FailureCode is null && retried.Transitions.Count == 0, "a retry clears the previous episode's failure");

var owned = new OwnedHost<SyntheticHost>();
var first = new SyntheticHost(); var second = new SyntheticHost();
owned.Adopt(first); owned.Adopt(second);
Check(owned.Owns(second) && !owned.Owns(first), "only the newest host is owned by the window");
Check(owned.ReleaseIfOwned(first) is null, "a stale episode cannot release the current host");
var released = owned.ReleaseIfOwned(second);
Check(ReferenceEquals(released, second) && owned.Current is null, "the owning episode releases its own host once");

Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed, failed = 0 }));

static async Task<int> Park(CancellationToken token) { await Task.Delay(Timeout.Infinite, token); return 1; }

internal sealed class SyntheticHost : IDisposable
{
    public void Dispose() { }
}
