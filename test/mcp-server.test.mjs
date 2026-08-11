import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes the expected narrow tool surface", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-bridge-test-"));
  context.after(() => fs.rm(bridgeDir, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-agent-bridge-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "browser_activate_tab",
      "browser_cdp_attach",
      "browser_cdp_detach",
      "browser_cdp_events",
      "browser_cdp_send",
      "browser_click",
      "browser_close_tab",
      "browser_fill",
      "browser_list_tabs",
      "browser_navigate",
      "browser_network_poll",
      "browser_network_start",
      "browser_network_stop",
      "browser_open_tab",
      "browser_screenshot",
      "browser_snapshot",
      "browser_status",
      "browser_watch_events",
    ],
  );

  const networkStart = tools.find((tool) => tool.name === "browser_network_start");
  assert.equal(networkStart.inputSchema.properties.rawSessionId.type, "string");
  assert.equal(networkStart.inputSchema.properties.urlMode.default, "origin_path");
  assert.deepEqual(networkStart.inputSchema.properties.urlMode.enum, ["origin_path", "full"]);

  const rawAttach = tools.find((tool) => tool.name === "browser_cdp_attach");
  assert.equal(rawAttach.inputSchema.properties.captureEvents.default, true);

  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /bridge_offline/);
});
