#!/usr/bin/env node
/** Remove the URL MCP systemd user service. The private env file is kept unless --purge. */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { bridgeDirectory } from "../lib/config.mjs";

const execFileAsync = promisify(execFile);
const SERVICE_NAME = "chrome-agent-bridge-mcp";

function unitFile() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "systemd",
    "user",
    `${SERVICE_NAME}.service`,
  );
}

const purge = process.argv.includes("--purge");

try {
  await execFileAsync("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
} catch {
  // Service may not be running.
}
await fs.rm(unitFile(), { force: true });
try {
  await execFileAsync("systemctl", ["--user", "daemon-reload"]);
} catch {
  // Best effort.
}
if (purge) {
  await fs.rm(path.join(bridgeDirectory(), "mcp-http.env"), { force: true });
}
process.stdout.write(`Removed ${unitFile()}\n`);
if (purge) process.stdout.write("Removed the private env file\n");
