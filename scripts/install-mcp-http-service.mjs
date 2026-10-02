#!/usr/bin/env node
/**
 * Install the URL (Streamable HTTP) MCP as a systemd *user* service.
 *
 * The service authenticates clients with the bridge token in auth.json, read on
 * every request, so Renew in the extension popup updates it everywhere and no
 * copy of the token is stored. Pass --token only to pin a separate, fixed
 * client-facing token; it is then written to a private env file
 * (`~/.chrome-agent-bridge/mcp-http.env`, mode 0600) that is never committed.
 *
 * Usage:
 *   npm run install-mcp-http -- --host 127.0.0.1,192.0.2.10 --port 43118
 *   npm run install-mcp-http -- --dry-run
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { bridgeDirectory, isValidHost, parseHostList } from "../lib/config.mjs";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "chrome-agent-bridge-mcp";

function parseArgs(argv) {
  const result = { dryRun: false, enable: true, linger: true, host: null, port: null, path: null, token: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host") result.host = argv[++index];
    else if (arg === "--port") result.port = argv[++index];
    else if (arg === "--path") result.path = argv[++index];
    else if (arg === "--token") result.token = argv[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--no-enable") result.enable = false;
    else if (arg === "--no-linger") result.linger = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (result.host != null) {
    const hosts = parseHostList(result.host);
    if (hosts.length === 0) throw new Error("--host requires at least one address");
    for (const host of hosts) {
      if (!isValidHost(host)) throw new Error(`Invalid host: ${host}`);
    }
    result.host = hosts.join(",");
  }
  if (result.port != null) {
    const port = Number(result.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    result.port = String(port);
  }
  if (result.path != null && !result.path.startsWith("/")) result.path = `/${result.path}`;
  return result;
}

function servicePaths() {
  const home = os.homedir();
  const bridgeDir = bridgeDirectory();
  return {
    envFile: path.join(bridgeDir, "mcp-http.env"),
    unitDir: path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "systemd", "user"),
    unitFile: path.join(
      process.env.XDG_CONFIG_HOME || path.join(home, ".config"),
      "systemd",
      "user",
      `${SERVICE_NAME}.service`,
    ),
  };
}

function renderEnvFile({ host, port, endpointPath, token }) {
  return [
    "# Chrome Agent Bridge URL MCP environment (private; never commit)",
    `CHROME_AGENT_BRIDGE_MCP_HOST=${host}`,
    `CHROME_AGENT_BRIDGE_MCP_PORT=${port}`,
    `CHROME_AGENT_BRIDGE_MCP_PATH=${endpointPath}`,
    ...(token
      ? [`CHROME_AGENT_BRIDGE_MCP_TOKEN=${token}`]
      : ["# No token here: clients use the bridge token in auth.json (extension popup)."]),
    "",
  ].join("\n");
}

function renderUnit({ nodePath, serverPath }) {
  return [
    "[Unit]",
    "Description=Chrome Agent Bridge URL MCP (Streamable HTTP)",
    "Documentation=https://github.com/escapeWu/chrome-agent-bridge",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "EnvironmentFile=%h/.chrome-agent-bridge/mcp-http.env",
    `ExecStart=${nodePath} ${serverPath}`,
    "Restart=always",
    "RestartSec=2",
    "StandardOutput=append:%h/.chrome-agent-bridge/mcp-http.log",
    "StandardError=append:%h/.chrome-agent-bridge/mcp-http.log",
    "NoNewPrivileges=true",
    "PrivateTmp=true",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = path.join(repoRoot, "mcp", "http-server.mjs");
const nodePath = process.execPath;
const { envFile, unitDir, unitFile } = servicePaths();

const token = args.token ?? null;
const envContent = renderEnvFile({
  host: args.host ?? "127.0.0.1",
  port: args.port ?? "43118",
  endpointPath: args.path ?? "/mcp",
  token,
});
const unitContent = renderUnit({ nodePath, serverPath });

if (args.dryRun) {
  process.stdout.write(`${JSON.stringify({ unitFile, envFile, unitContent, envContent }, null, 2)}\n`);
} else {
  await fs.mkdir(path.dirname(envFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(envFile, envContent, { mode: 0o600 });
  await fs.chmod(envFile, 0o600);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(unitFile, unitContent, { mode: 0o644 });

  process.stdout.write(`Wrote ${envFile}\n`);
  process.stdout.write(`Wrote ${unitFile}\n`);

  if (args.enable) {
    await execFileAsync("systemctl", ["--user", "daemon-reload"]);
    await execFileAsync("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
    process.stdout.write(`Enabled and started ${SERVICE_NAME}.service\n`);
    if (args.linger) {
      const user = os.userInfo().username;
      try {
        await execFileAsync("loginctl", ["enable-linger", user]);
        process.stdout.write(`Enabled linger for ${user} (service starts at boot)\n`);
      } catch (error) {
        process.stdout.write(`Could not enable linger automatically: ${error.message}\n`);
        process.stdout.write(`Run manually: sudo loginctl enable-linger ${user}\n`);
      }
    }
    process.stdout.write(`Status: systemctl --user status ${SERVICE_NAME}\n`);
  }
}
