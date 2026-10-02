import { VERSION } from "../lib/version.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = `cab_${"b".repeat(43)}`;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for URL MCP health endpoint");
}

function parseSse(text) {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) return JSON.parse(line.slice(6));
  }
  throw new Error(`No SSE data line in response: ${text.slice(0, 200)}`);
}

async function rpc(url, token, body) {
  const response = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text };
}

test("URL MCP exposes the same tools behind a bearer token", async (context) => {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "mcp", "http-server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_AGENT_BRIDGE_MCP_HOST: "127.0.0.1",
      CHROME_AGENT_BRIDGE_MCP_PORT: String(port),
      CHROME_AGENT_BRIDGE_MCP_TOKEN: TOKEN,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  context.after(() => {
    if (!child.killed) child.kill("SIGTERM");
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url);

  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "chrome-agent-bridge-mcp" });

  const unauthorized = await rpc(url, `cab_${"c".repeat(43)}`, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
  });
  assert.equal(unauthorized.status, 401);

  const noAuth = await fetch(`${url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(noAuth.status, 401);

  const initialized = await rpc(url, TOKEN, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "probe", version: "1" },
    },
  });
  assert.equal(initialized.status, 200);
  const initPayload = parseSse(initialized.text);
  assert.equal(initPayload.result.serverInfo.name, "chrome-agent-bridge");
  assert.equal(initPayload.result.serverInfo.version, VERSION);

  const listed = await rpc(url, TOKEN, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(listed.status, 200);
  const tools = parseSse(listed.text).result.tools.map((tool) => tool.name);
  assert.ok(tools.includes("browser_status"));
  assert.ok(tools.includes("browser_list_tabs"));
  assert.ok(tools.includes("browser_cdp_attach"));
  assert.ok(tools.includes("understand_code"));
  assert.ok(tools.length >= 90);

  const notFound = await fetch(`${url}/nope`);
  assert.equal(notFound.status, 404);
});
