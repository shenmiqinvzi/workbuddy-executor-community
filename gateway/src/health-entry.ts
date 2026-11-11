import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { loadDotEnv } from "./env.js";
import { WorkBuddyClient } from "./workbuddy-client.js";
import { healthReport } from "./health-report.js";
import { runtimeVersion } from "./runtime-version.js";

/**
 * Read-only health entry.
 *
 * This process answers exactly one question -- "is this installation's transport
 * reachable?" -- and deliberately constructs no TaskStore, no coordinator and no
 * application service. Starting it can therefore never create the task database,
 * run a schema migration, reclaim a stale worker or write a queue row, which is
 * what a readiness probe must guarantee.
 */
loadDotEnv();
const config = loadConfig();
const client = new WorkBuddyClient(config);
const server = new McpServer({ name: "codex-workbuddy-gateway-health", version: runtimeVersion.packageVersion });
server.tool(
  "workbuddy_health",
  "Read-only readiness probe. Reports the transport state of the instance this process was configured with; it never opens the task database and never dispatches work. Online does not prove login, model availability or task success.",
  { sessionId: z.string().optional() },
  async ({ sessionId }) => ({ content: [{ type: "text" as const, text: JSON.stringify(await healthReport({ config, client, sessionId })) }] }),
);
await server.connect(new StdioServerTransport());
