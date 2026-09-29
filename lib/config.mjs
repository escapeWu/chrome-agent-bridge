import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.escape_wu.chrome_agent_bridge";
export const EXTENSION_ID = "hkedmoboloodflgcaidimhddljdnndcd";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_NATIVE_MESSAGE_BYTES = 4 * 1024 * 1024;

/** Hosts the native host binds when no explicit configuration is present. */
export const DEFAULT_BIND_HOSTS = ["127.0.0.1"];
export const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

export function bridgeDirectory(env = process.env) {
  return path.resolve(
    env.CHROME_AGENT_BRIDGE_DIR || path.join(os.homedir(), ".chrome-agent-bridge"),
  );
}

export function runtimeFile(env = process.env) {
  return path.join(bridgeDirectory(env), "runtime.json");
}

export function authFile(env = process.env) {
  return path.join(bridgeDirectory(env), "auth.json");
}

/** Optional operator file that declares additional bind addresses. */
export function networkConfigFile(env = process.env) {
  return path.join(bridgeDirectory(env), "network.json");
}

export function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function isWildcardHost(host) {
  return WILDCARD_HOSTS.has(host);
}

/**
 * Validate a bind/connect host token. Accepts an IPv4 or IPv6 literal, or a DNS
 * hostname. Rejects anything carrying a scheme, path, port, credentials, or
 * whitespace so a config value can never smuggle a URL into the client.
 */
export function isValidHost(host) {
  if (typeof host !== "string") return false;
  const value = host.trim();
  if (value.length === 0 || value.length > 253) return false;
  if (net.isIPv4(value) || net.isIPv6(value)) return true;
  if (value.includes(":") || value.includes("/") || value.includes("@") || value.includes(" ")) {
    return false;
  }
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    value,
  );
}

export function parseHostList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
  return [];
}

function dedupeHosts(hosts) {
  const seen = new Set();
  const result = [];
  for (const host of hosts) {
    if (seen.has(host)) continue;
    seen.add(host);
    result.push(host);
  }
  return result;
}

/** Enumerate concrete non-internal IPv4/IPv6 addresses for wildcard expansion. */
export function localAddresses() {
  const addresses = [];
  const interfaces = os.networkInterfaces();
  for (const records of Object.values(interfaces)) {
    for (const record of records ?? []) {
      if (record.internal) continue;
      const family = record.family === "IPv6" || record.family === 6 ? "IPv6" : "IPv4";
      addresses.push({ address: record.address, family });
    }
  }
  return addresses;
}

/**
 * Resolve the bind hosts for the native host.
 *
 * Priority:
 *   1. CHROME_AGENT_BRIDGE_BIND_HOSTS (comma separated)
 *   2. <bridgeDirectory>/network.json `{ "bindHosts": [...] }`
 *   3. 127.0.0.1
 */
export async function bridgeBindHosts(env = process.env) {
  const fromEnv = parseHostList(env.CHROME_AGENT_BRIDGE_BIND_HOSTS);
  if (fromEnv.length > 0) return dedupeHosts(fromEnv);

  const fromFile = parseHostList((await readNetworkConfig(env)).bindHosts);
  if (fromFile.length > 0) return dedupeHosts(fromFile);

  return [...DEFAULT_BIND_HOSTS];
}

/** Read the optional operator network configuration file, or an empty object. */
export async function readNetworkConfig(env = process.env) {
  try {
    const raw = await fs.readFile(networkConfigFile(env), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {};
  }
}

/**
 * Resolve the TCP port. 0 means an ephemeral port. A fixed port lets a client on
 * another machine reach the bridge without copying runtime.json first.
 *
 * Priority: CHROME_AGENT_BRIDGE_PORT > network.json `port` > 0.
 */
export async function bridgeBindPort(env = process.env) {
  const fromEnv = env.CHROME_AGENT_BRIDGE_PORT;
  const raw =
    fromEnv != null && String(fromEnv).trim() !== ""
      ? fromEnv
      : (await readNetworkConfig(env)).port;
  if (raw == null || String(raw).trim() === "") return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const error = new Error("Chrome Agent Bridge port must be an integer from 1 to 65535");
    error.code = "invalid_port";
    throw error;
  }
  return port;
}

/**
 * The set of addresses a client may connect to for a given runtime record.
 * A non-loopback primary host is only honored when the native host also declared
 * it in `hosts`, so a hand-edited runtime file cannot silently redirect a client
 * to an arbitrary address.
 */
export function runtimeAllowedHosts(runtime) {
  const allowed = new Set();
  if (Array.isArray(runtime?.hosts)) {
    for (const host of runtime.hosts) {
      if (isValidHost(host)) allowed.add(host.trim());
    }
  }
  if (isValidHost(runtime?.host)) {
    const primary = runtime.host.trim();
    if (isLoopbackHost(primary) || allowed.has(primary)) allowed.add(primary);
  }
  if (allowed.size === 0) allowed.add("127.0.0.1");
  return allowed;
}

/** Format a host for use inside an HTTP URL (brackets IPv6 literals). */
export function formatHostForUrl(host) {
  const value = host.trim();
  if (value.includes(":") && !value.startsWith("[")) return `[${value}]`;
  return value;
}

/**
 * Resolve which allowed host the client should connect to.
 * CHROME_AGENT_BRIDGE_CONNECT_HOST overrides the runtime record when allowed.
 */
export function resolveConnectHost(runtime, allowed, env = process.env) {
  const override = env.CHROME_AGENT_BRIDGE_CONNECT_HOST;
  const requested =
    typeof override === "string" && override.trim().length > 0 ? override.trim() : runtime?.host;
  const host = isValidHost(requested) ? requested.trim() : "127.0.0.1";
  if (!allowed.has(host)) {
    const error = new Error(
      `Chrome Agent Bridge runtime host ${host} is not in the allowed host set`,
    );
    error.code = "bridge_offline";
    throw error;
  }
  return host;
}
