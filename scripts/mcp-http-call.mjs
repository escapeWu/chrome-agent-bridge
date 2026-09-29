#!/usr/bin/env node
/**
 * Minimal Chrome Agent Bridge URL-MCP caller.
 *
 * Usage:
 *   node scripts/mcp-http-call.mjs <toolName> ['{"json":1}']
 *   node scripts/mcp-http-call.mjs tools/list
 *
 * Environment:
 *   CHROME_AGENT_BRIDGE_MCP_URL    e.g. http://192.0.2.10:43118/mcp
 *   CHROME_AGENT_BRIDGE_MCP_TOKEN  bearer token
 */
import process from "node:process";

const url = process.env.CHROME_AGENT_BRIDGE_MCP_URL || "http://192.0.2.10:43118/mcp";
const token = process.env.CHROME_AGENT_BRIDGE_MCP_TOKEN;
if (!token) {
  process.stderr.write("Set CHROME_AGENT_BRIDGE_MCP_TOKEN\n");
  process.exit(2);
}

const [name, rawArgs] = process.argv.slice(2);
if (!name) {
  process.stderr.write("Usage: node scripts/mcp-http-call.mjs <toolName|tools/list> ['{\"json\":1}']\n");
  process.exit(2);
}

const isList = name === "tools/list" || name === "list";
const body = isList
  ? { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }
  : {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: rawArgs ? JSON.parse(rawArgs) : {} },
    };

const response = await fetch(url, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  },
  body: JSON.stringify(body),
});

const text = await response.text();
if (!response.ok) {
  process.stderr.write(`HTTP ${response.status}: ${text}\n`);
  process.exit(1);
}

// Use process.exitCode (not process.exit) so Node flushes stdout before exiting;
// process.exit() can truncate piped output.
let handled = false;
for (const line of text.split("\n")) {
  if (!line.startsWith("data: ")) continue;
  const payload = JSON.parse(line.slice(6));
  handled = true;
  if (payload.error) {
    process.stderr.write(`${JSON.stringify(payload.error, null, 2)}\n`);
    process.exitCode = 1;
  } else if (isList) {
    process.stdout.write(`${payload.result.tools.map((tool) => tool.name).join("\n")}\n`);
  } else {
    process.stdout.write(`${payload.result.content?.[0]?.text ?? JSON.stringify(payload.result, null, 2)}\n`);
  }
  break;
}

if (!handled) {
  process.stderr.write(`No SSE data line: ${text.slice(0, 200)}\n`);
  process.exitCode = 1;
}
