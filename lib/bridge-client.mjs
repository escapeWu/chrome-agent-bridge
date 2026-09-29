import fs from "node:fs/promises";
import { readAuthToken } from "./auth-token.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  formatHostForUrl,
  isValidHost,
  resolveConnectHost,
  runtimeAllowedHosts,
  runtimeFile,
} from "./config.mjs";

export class BridgeOfflineError extends Error {
  constructor(message = "Chrome Agent Bridge is offline") {
    super(message);
    this.name = "BridgeOfflineError";
    this.code = "bridge_offline";
  }
}

/**
 * Remote-client fallback: when no runtime.json is available, an operator may pin
 * the endpoint explicitly. Both the host and port must be present, and the host
 * must be a valid literal, so this never guesses an address.
 */
function readRuntimeFromEnvironment() {
  const host = typeof process.env.CHROME_AGENT_BRIDGE_CONNECT_HOST === "string"
    ? process.env.CHROME_AGENT_BRIDGE_CONNECT_HOST.trim()
    : "";
  const port = Number(process.env.CHROME_AGENT_BRIDGE_PORT);
  if (!isValidHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new BridgeOfflineError();
  }
  return { runtime: { schemaVersion: 2, host, port, hosts: [host] }, host, port };
}

async function readRuntime() {
  let raw;
  try {
    raw = await fs.readFile(runtimeFile(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return readRuntimeFromEnvironment();
    throw error;
  }

  let runtime;
  try {
    runtime = JSON.parse(raw);
  } catch {
    throw new BridgeOfflineError("Chrome Agent Bridge runtime file is invalid");
  }

  if (
    ![1, 2].includes(runtime?.schemaVersion) ||
    !Number.isInteger(runtime?.port) ||
    runtime.port < 1 ||
    runtime.port > 65535
  ) {
    throw new BridgeOfflineError("Chrome Agent Bridge runtime file is invalid");
  }

  const allowed = runtimeAllowedHosts(runtime);
  const host = resolveConnectHost(runtime, allowed);
  return { runtime, host, port: runtime.port };
}

export async function callBridge(method, params = {}, options = {}) {
  const { runtime, host, port } = await readRuntime();
  const token =
    runtime.schemaVersion === 1 && typeof runtime.token === "string"
      ? runtime.token
      : await readAuthToken();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`http://${formatHostForUrl(host)}:${port}/rpc`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ method, params }),
      signal: controller.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      const error = new Error(payload?.error?.message || `Bridge request failed (${response.status})`);
      error.code = payload?.error?.code || "bridge_error";
      throw error;
    }
    return payload.result;
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Chrome Agent Bridge request timed out");
      timeoutError.code = "bridge_timeout";
      throw timeoutError;
    }
    if (error instanceof BridgeOfflineError || error?.code) throw error;
    throw new BridgeOfflineError("Cannot connect to the Chrome Agent Bridge native host");
  } finally {
    clearTimeout(timeout);
  }
}
