#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { bridgeDirectory, EXTENSION_ID, HOST_NAME, isValidHost, parseHostList } from "../lib/config.mjs";

function parseArgs(argv) {
  const result = { dryRun: false, extensionId: EXTENSION_ID, bindHosts: null, port: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--extension-id") result.extensionId = argv[++index];
    else if (arg === "--bind-hosts") result.bindHosts = argv[++index];
    else if (arg === "--port") result.port = argv[++index];
    else if (arg === "--dry-run") result.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!/^[a-p]{32}$/.test(result.extensionId)) {
    throw new Error("Pass a valid Chrome extension ID with --extension-id <32 characters a-p>");
  }
  if (result.bindHosts != null) {
    const hosts = parseHostList(result.bindHosts);
    if (hosts.length === 0) throw new Error("Pass at least one host with --bind-hosts");
    for (const host of hosts) {
      if (!isValidHost(host)) throw new Error(`Invalid host in --bind-hosts: ${host}`);
    }
    result.bindHosts = hosts.join(",");
  }
  if (result.port != null) {
    const port = Number(result.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("--port must be an integer from 1 to 65535");
    }
    result.port = String(port);
  }
  return result;
}

function manifestPath() {
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    );
  }
  if (process.platform === "linux") {
    return path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "google-chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    );
  }
  throw new Error("The installer currently supports macOS and Linux. Windows support is not yet implemented.");
}

const args = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hostModulePath = path.join(projectRoot, "native-host", "host.mjs");
const hostPath = path.join(bridgeDirectory(), "native-host-launcher");
const target = manifestPath();
const manifest = {
  name: HOST_NAME,
  description: "Chrome Agent Bridge native messaging host",
  path: hostPath,
  type: "stdio",
  allowed_origins: [`chrome-extension://${args.extensionId}/`],
};

if (args.dryRun) {
  process.stdout.write(
    `${JSON.stringify({ target, manifest, nodePath: process.execPath, hostModulePath, bindHosts: args.bindHosts, port: args.port }, null, 2)}\n`,
  );
} else {
  const shellQuote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const launcherLines = ["#!/bin/sh", "set -eu"];
  if (args.bindHosts) {
    launcherLines.push(`CHROME_AGENT_BRIDGE_BIND_HOSTS=${shellQuote(args.bindHosts)}`);
    launcherLines.push("export CHROME_AGENT_BRIDGE_BIND_HOSTS");
  }
  if (args.port) {
    launcherLines.push(`CHROME_AGENT_BRIDGE_PORT=${shellQuote(args.port)}`);
    launcherLines.push("export CHROME_AGENT_BRIDGE_PORT");
  }
  launcherLines.push(`exec ${shellQuote(process.execPath)} ${shellQuote(hostModulePath)}`);
  launcherLines.push("");
  const launcher = launcherLines.join("\n");
  await fs.mkdir(path.dirname(hostPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(hostPath, launcher, { mode: 0o700 });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write(`Installed native host manifest: ${target}\n`);
  process.stdout.write("Reload the Chrome extension to connect.\n");
  if (args.bindHosts) {
    process.stdout.write(`Bridge bind hosts: ${args.bindHosts}\n`);
  }
  if (args.port) {
    process.stdout.write(`Bridge port: ${args.port}\n`);
  }
}
