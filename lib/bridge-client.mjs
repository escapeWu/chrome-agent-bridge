import fs from "node:fs/promises";
import { readAuthToken } from "./auth-token.mjs";
import {
  describeInstance,
  listInstances,
  prefixSessionId,
  selectInstance,
  splitSessionId,
} from "./instance-registry.mjs";
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

/** Session fields a caller may pass back that carry an instance prefix. */
const SESSION_FIELDS = ["sessionId", "rawSessionId"];

function routeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Work out which browser a call targets and strip routing data from the params
 * sent to the extension: the `browser` selector and the `<instanceId>~` prefix
 * that this client adds to session IDs.
 */
function extractRoute(params) {
  const { browser, ...rest } = params ?? {};
  let prefixed = null;
  for (const field of SESSION_FIELDS) {
    if (typeof rest[field] !== "string") continue;
    const { instanceId, sessionId } = splitSessionId(rest[field]);
    if (instanceId == null) continue;
    if (prefixed != null && prefixed !== instanceId) {
      throw routeError("browser_mismatch", "Session IDs belong to different browsers");
    }
    prefixed = instanceId;
    rest[field] = sessionId;
  }
  return { browser: typeof browser === "string" && browser !== "" ? browser : null, prefixed, params: rest };
}

async function resolveTarget(route) {
  const instances = await listInstances();
  if (instances.length === 0) {
    // No registry: a host that predates instance registration, or a remote client.
    if (route.browser != null || process.env.CHROME_AGENT_BRIDGE_INSTANCE) {
      throw routeError(
        "browser_not_found",
        "No registered browser instances; omit the browser selector for a single bridge",
      );
    }
    const target = await readRuntime();
    return { ...target, instance: null };
  }

  if (route.browser != null && route.prefixed != null) {
    const chosen = selectInstance(instances, route.browser);
    if (chosen.instanceId !== route.prefixed) {
      throw routeError("browser_mismatch", `Session belongs to browser ${route.prefixed}, not ${chosen.instanceId}`);
    }
  }
  const selector = route.prefixed ?? route.browser ?? (process.env.CHROME_AGENT_BRIDGE_INSTANCE?.trim() || null);
  const instance = selectInstance(instances, selector);
  const runtime = { schemaVersion: 3, host: instance.host, hosts: instance.hosts, port: instance.port };
  const host = resolveConnectHost(runtime, runtimeAllowedHosts(runtime));
  return { runtime, host, port: instance.port, instance };
}

function prefixResultSessions(result, instanceId) {
  if (result == null || typeof result !== "object" || Array.isArray(result)) return result;
  const next = { ...result };
  for (const field of SESSION_FIELDS) {
    if (typeof next[field] === "string" && splitSessionId(next[field]).instanceId == null) {
      next[field] = prefixSessionId(instanceId, next[field]);
    }
  }
  return next;
}

async function request(target, method, params, options) {
  const { runtime, host, port } = target;
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

/**
 * Call the browser selected by `params.browser`, a prefixed session ID,
 * CHROME_AGENT_BRIDGE_INSTANCE, or the only connected browser, in that order.
 * Pass `options.route = {}` to learn which instance served the call.
 */
export async function callBridge(method, params = {}, options = {}) {
  const route = extractRoute(params);
  const target = await resolveTarget(route);
  if (options.route && target.instance) Object.assign(options.route, describeInstance(target.instance));
  const result = await request(target, method, route.params, options);
  return target.instance ? prefixResultSessions(result, target.instance.instanceId) : result;
}

/** Call one already-resolved instance record (used to survey every browser). */
export function callInstance(instance, method, params = {}, options = {}) {
  const runtime = { schemaVersion: 3, host: instance.host, hosts: instance.hosts, port: instance.port };
  const host = resolveConnectHost(runtime, runtimeAllowedHosts(runtime));
  return request({ runtime, host, port: instance.port }, method, params, options);
}

/** Instances reachable from this machine, or the single legacy bridge. */
export async function listBrowserInstances() {
  const instances = await listInstances();
  if (instances.length > 0) return instances.map((instance) => ({ ...instance, legacy: false }));
  try {
    const { runtime, host, port } = await readRuntime();
    return [{ instanceId: null, label: null, legacy: true, host, hosts: runtime.hosts ?? [host], port, pid: runtime.pid ?? null, startedAt: runtime.startedAt ?? null }];
  } catch {
    return [];
  }
}
