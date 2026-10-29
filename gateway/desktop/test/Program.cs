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
Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { passed, failed = 0 }));
