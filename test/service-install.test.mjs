import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = `cab_${"d".repeat(43)}`;

test("URL MCP service installer dry-run renders a private env file and unit", async () => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-mcp-svc-bridge-"));
  const configHome = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-mcp-svc-config-"));

  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "install-mcp-http-service.mjs"),
      "--dry-run",
      "--host",
      "127.0.0.1,192.0.2.10",
      "--port",
      "43118",
      "--token",
      TOKEN,
    ],
    { env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir, XDG_CONFIG_HOME: configHome } },
  );
  const result = JSON.parse(stdout);

  assert.ok(result.unitFile.startsWith(configHome));
  assert.ok(result.unitFile.endsWith("chrome-agent-bridge-mcp.service"));
  assert.equal(result.envFile, path.join(bridgeDir, "mcp-http.env"));

  assert.match(result.unitContent, /\[Service\]/);
  assert.match(result.unitContent, /EnvironmentFile=%h\/\.chrome-agent-bridge\/mcp-http\.env/);
  assert.match(result.unitContent, /mcp\/http-server\.mjs/);
  assert.match(result.unitContent, /Restart=always/);
  assert.match(result.unitContent, /WantedBy=default\.target/);

  assert.match(result.envContent, /CHROME_AGENT_BRIDGE_MCP_HOST=127\.0\.0\.1,192\.0\.2\.10/);
  assert.match(result.envContent, /CHROME_AGENT_BRIDGE_MCP_PORT=43118/);
  assert.match(result.envContent, /CHROME_AGENT_BRIDGE_MCP_PATH=\/mcp/);
  assert.match(result.envContent, new RegExp(`CHROME_AGENT_BRIDGE_MCP_TOKEN=${TOKEN}`));

  // Dry-run must not write anything.
  await assert.rejects(() => fs.stat(result.envFile), (error) => error.code === "ENOENT");
  await assert.rejects(() => fs.stat(result.unitFile), (error) => error.code === "ENOENT");

  await fs.rm(bridgeDir, { recursive: true, force: true });
  await fs.rm(configHome, { recursive: true, force: true });
});

test("URL MCP service installer rejects an invalid host or port", async () => {
  await assert.rejects(() =>
    execFileAsync(process.execPath, [
      path.join(root, "scripts", "install-mcp-http-service.mjs"),
      "--dry-run",
      "--host",
      "http://evil",
    ]),
  );
  await assert.rejects(() =>
    execFileAsync(process.execPath, [
      path.join(root, "scripts", "install-mcp-http-service.mjs"),
      "--dry-run",
      "--port",
      "70000",
    ]),
  );
});
