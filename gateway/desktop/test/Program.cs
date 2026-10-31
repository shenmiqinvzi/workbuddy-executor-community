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
Check(DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49152/workbench/desktop/command","/workbench/desktop/command","POST","POST"), "exact native command interception route");
Check(!DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49153/workbench/desktop/command","/workbench/desktop/command","POST","POST"), "native control rejects another port");
Check(!DesktopControlPolicy.IsRoute(origin,"http://127.0.0.1:49152/workbench/desktop/command?extra=1","/workbench/desktop/command","POST","POST"), "native control rejects query aliases");
Check(DesktopControlPolicy.IsTrustedPage(origin,"http://127.0.0.1:49152/workbench/#taskId=test"), "only the main document is a trusted control surface");
Check(!DesktopControlPolicy.IsTrustedPage(origin,"http://127.0.0.1:49152/workbench/app.mjs"), "asset documents cannot call native control");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"commit\",\"parameters\":{}}"), "page cannot directly commit backend drafts");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"cancel\",\"parameters\":{}}"), "page cannot cancel or accept tasks");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"catalog\",\"parameters\":{},\"command\":\"bad\"}"), "unknown native fields rejected");
Reject(()=>DesktopControlPolicy.Decode("{\"action\":\"dispatch\",\"parameters\":{\"model\":\"different\"}}"), "dispatch body cannot replace reviewed terms");
Reject(()=>DesktopControlPolicy.Decode(new string('x',65537)), "native request has a byte bound");
Check(DesktopControlPolicy.Decode("{\"action\":\"catalog\",\"parameters\":{}}").Action=="catalog", "catalog action remains explicit");
Check(DesktopControlPolicy.Decode("{\"action\":\"dispatch\",\"parameters\":{\"draftId\":\"11111111-1111-1111-1111-111111111111\",\"digest\":\""+new string('a',64)+"\"}}").Action=="dispatch", "page dispatch references an immutable draft only");
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
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed, failed = 0 }));
