import { DshClient } from "./dsh-client.js";
import { DSH_DISCOVERY_SCHEMA_VERSION, dshSessionsFor, summarizeDshHosts } from "./dsh-discovery.js";

// Read-only diagnostics; no TaskStore, credentials output, selection, activation
// or model request. Registry discovery and native bridge readiness are distinct.
const args = process.argv.slice(2);
const values = new Map<string, string>();
try {
  for (let i = 0; i < args.length; i += 2) {
    if (!["--cwd", "--session", "--host"].includes(args[i]!) || !args[i + 1] || values.has(args[i]!)) throw Error("arguments");
    values.set(args[i]!, args[i + 1]!);
  }
  const cwd = values.get("--cwd"); if (!cwd) throw Error("arguments");
  const registry = dshSessionsFor(cwd, values.get("--session"));
  const client = new DshClient();
  const hosts = summarizeDshHosts(client);
  const id = values.get("--host") ?? (hosts.length === 1 ? hosts[0]!.hostId : undefined);
  let bridge: unknown = { available: false, reason: hosts.length ? "host_selection_required" : "native_bridge_not_registered" };
  if (id && hosts.some(host => host.hostId === id)) {
    try { bridge = { available: true, health: await client.health(id), catalog: await client.models(id) }; }
    catch { bridge = { available: false, reason: "native_bridge_unavailable" }; }
  }
  console.log(JSON.stringify({ schemaVersion: DSH_DISCOVERY_SCHEMA_VERSION, readOnly: true, registry, hosts, bridge }));
} catch { console.log(JSON.stringify({ ok: false, code: "DSH_DISCOVERY_INVALID", message: "Use --cwd <existing absolute directory> with optional --session and --host." })); process.exitCode = 1; }
