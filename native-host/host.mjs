#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import process from "node:process";
import {
  loadOrCreateAuthState,
  renewAuthState,
  writePrivateJsonAtomic,
} from "../lib/auth-token.mjs";
import {
  bridgeBindHosts,
  bridgePortCandidates,
  bridgeDirectory,
  DEFAULT_TIMEOUT_MS,
  isLoopbackHost,
  isWildcardHost,
  localAddresses,
  runtimeFile,
} from "../lib/config.mjs";
import {
  defaultInstanceLabel,
  isProcessAlive,
  isValidInstanceId,
  normalizeLabel,
  readInstanceRecord,
  removeInstanceRecord,
  writeInstanceRecord,
} from "../lib/instance-registry.mjs";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";
import { VERSION } from "../lib/version.mjs";

let authState = await loadOrCreateAuthState();
const pending = new Map();
const eventBuffer = [];
const eventWaiters = new Set();
let nextRequestId = 1;
let eventSequence = 0;
let extensionVersion = "0.0.0";
let previousTabs = null;
let cleanedUp = false;
let runtimeIdentity = null;
let instanceIdentity = null;
let registerChain = Promise.resolve();
let markRuntimeReady;
const runtimeReady = new Promise((resolve) => {
  markRuntimeReady = resolve;
});

function log(message) {
  process.stderr.write(`[chrome-agent-bridge] ${message}\n`);
}

function sendNative(value) {
  process.stdout.write(encodeNativeMessage(value));
}

function serializeError(error, fallbackCode = "bridge_error") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    ...(isDetails(error?.details) ? { details: error.details } : {}),
  };
}

/** Structured error context from the extension, such as who holds a debugger. */
function isDetails(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isAuthorized(header, expectedToken) {
  const prefix = "Bearer ";
  const provided = typeof header === "string" && header.startsWith(prefix)
    ? header.slice(prefix.length)
    : "";
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function publicAuthState() {
  return {
    token: authState.token,
    createdAt: authState.createdAt,
    rotatedAt: authState.rotatedAt,
  };
}

async function handleAuthRequest(message) {
  if (typeof message.id !== "string") return;
  try {
    if (message.action === "renew") {
      authState = await renewAuthState();
    } else if (message.action !== "get") {
      const error = new Error(`Unsupported auth action: ${message.action}`);
      error.code = "auth_action_invalid";
      throw error;
    } else authState = await loadOrCreateAuthState();
    sendNative({ type: "auth.response", id: message.id, ok: true, result: publicAuthState() });
  } catch (error) {
    sendNative({ type: "auth.response", id: message.id, ok: false, error: serializeError(error) });
  }
}

function forwardToExtension(method, params) {
  const id = String(nextRequestId++);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      // Only this RPC stops waiting. The extension may still be running the
      // request (for example a Chrome command), so callers must re-inspect
      // state rather than assume it failed or retry a write blindly.
      const error = new Error(`Extension request timed out: ${method}`);
      error.code = "extension_timeout";
      reject(error);
    }, DEFAULT_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timeout });
    sendNative({ type: "request", id, method, params });
  });
}

function eventTabId(event) {
  return event?.data?.tabId ?? event?.data?.id ?? event?.data?.tab?.id;
}

function eventResult(afterSequence, tabId) {
  const earliestSequence = eventBuffer[0]?.sequence ?? eventSequence + 1;
  const events = eventBuffer.filter(
    (event) => event.sequence > afterSequence && (tabId == null || eventTabId(event) === tabId),
  );
  return {
    cursor: eventSequence,
    events,
    truncated: afterSequence < earliestSequence - 1,
  };
}

function pollParameters(params) {
  const afterSequence = Number(params?.afterSequence ?? 0);
  const timeoutMs = Number(params?.timeoutMs ?? 10_000);
  const tabId = params?.tabId == null ? undefined : Number(params.tabId);
  if (!Number.isInteger(afterSequence) || afterSequence < 0) {
    const error = new Error("afterSequence must be a non-negative integer");
    error.code = "invalid_request";
    throw error;
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 25_000) {
    const error = new Error("timeoutMs must be an integer from 0 to 25000");
    error.code = "invalid_request";
    throw error;
  }
  if (tabId != null && (!Number.isInteger(tabId) || tabId < 0)) {
    const error = new Error("tabId must be a non-negative integer when provided");
    error.code = "invalid_request";
    throw error;
  }
  return { afterSequence, timeoutMs, tabId };
}

function supportsPushedEvents() {
  const [major, minor] = extensionVersion.split(".").map(Number);
  return major > 0 || minor >= 2;
}

function waitForPushedEvents(afterSequence, timeoutMs, tabId) {

  const current = eventResult(afterSequence, tabId);
  if (current.events.length > 0 || timeoutMs === 0) return Promise.resolve(current);
  return new Promise((resolve) => {
    const waiter = { afterSequence, tabId, resolve };
    waiter.timeout = setTimeout(() => {
      eventWaiters.delete(waiter);
      resolve(eventResult(afterSequence, tabId));
    }, timeoutMs);
    eventWaiters.add(waiter);
  });
}

function tabChanged(before, after) {
  return (
    before.active !== after.active ||
    before.title !== after.title ||
    before.url !== after.url ||
    before.windowId !== after.windowId
  );
}

async function refreshTabSnapshot() {
  const tabs = await forwardToExtension("tabs.list", {});
  const currentTabs = new Map(tabs.map((tab) => [tab.id, tab]));
  if (previousTabs == null) {
    previousTabs = currentTabs;
    return;
  }

  for (const [tabId, tab] of currentTabs) {
    const previous = previousTabs.get(tabId);
    if (previous == null) recordEvent("tab.created", tab);
    else if (tabChanged(previous, tab)) {
      recordEvent("tab.updated", { tabId, tab, previousTab: previous, source: "snapshot" });
    }
  }
  for (const [tabId, tab] of previousTabs) {
    if (!currentTabs.has(tabId)) recordEvent("tab.removed", { tabId, tab, source: "snapshot" });
  }
  previousTabs = currentTabs;
}

async function pollSnapshotEvents(afterSequence, timeoutMs, tabId) {
  const deadline = Date.now() + timeoutMs;
  await refreshTabSnapshot();
  let current = eventResult(afterSequence, tabId);
  if (current.events.length > 0 || timeoutMs === 0) return current;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
    await refreshTabSnapshot();
    current = eventResult(afterSequence, tabId);
    if (current.events.length > 0) return current;
  }
  return eventResult(afterSequence, tabId);
}

function pollEvents(params) {
  const { afterSequence, timeoutMs, tabId } = pollParameters(params);
  return supportsPushedEvents()
    ? waitForPushedEvents(afterSequence, timeoutMs, tabId)
    : pollSnapshotEvents(afterSequence, timeoutMs, tabId);
}

function recordEvent(event, data) {
  eventSequence += 1;
  eventBuffer.push({ sequence: eventSequence, event, data, observedAt: new Date().toISOString() });
  if (eventBuffer.length > 500) eventBuffer.splice(0, eventBuffer.length - 500);
  for (const waiter of [...eventWaiters]) {
    const result = eventResult(waiter.afterSequence, waiter.tabId);
    if (result.events.length === 0) continue;
    eventWaiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  }
}

const CONFLICT_GRACE_MS = 2_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Publish this host in instances/<id>.json so a router can reach it by browser
 * identity. Changes are serialized: hello and a later rename must not interleave.
 */
function queueRegistration(request) {
  registerChain = registerChain
    .then(() => registerInstance(request))
    .catch((error) => log(`Instance registration failed: ${error.message}`));
}

async function registerInstance({ instanceId, label }) {
  await runtimeReady;
  const existing = await readInstanceRecord(instanceId);
  if (existing && existing.pid !== process.pid) {
    // A restarting service worker briefly leaves the previous host alive; wait it out.
    const deadline = Date.now() + CONFLICT_GRACE_MS;
    while (isProcessAlive(existing.pid) && Date.now() < deadline) await sleep(100);
    if (isProcessAlive(existing.pid)) {
      sendNative({ type: "instance.conflict", instanceId });
      return;
    }
  }
  if (instanceIdentity && instanceIdentity.instanceId !== instanceId) {
    await removeInstanceRecord(instanceIdentity.instanceId, process.pid);
  }
  const sameInstance = instanceIdentity?.instanceId === instanceId;
  instanceIdentity = {
    instanceId,
    label: normalizeLabel(label ?? (sameInstance ? instanceIdentity.label : undefined) ?? defaultInstanceLabel(instanceId), instanceId),
  };
  await writeInstanceRecord({
    instanceId,
    label: instanceIdentity.label,
    host: runtimeIdentity.host,
    hosts: runtimeIdentity.hosts,
    port: runtimeIdentity.port,
    pid: process.pid,
    startedAt: runtimeIdentity.startedAt,
    extensionVersion,
  });
}

function handleExtensionMessage(message) {
  if (message?.type === "auth.request") {
    void handleAuthRequest(message);
    return;
  }
  if (message?.type === "hello") {
    extensionVersion = typeof message.extensionVersion === "string" ? message.extensionVersion : "0.0.0";
    // An extension that predates instance registration still gets a record, keyed
    // by this host's pid, so it stays routable next to newer browsers.
    const instanceId = isValidInstanceId(message.instanceId) ? message.instanceId : `legacy-${process.pid}`;
    const label = typeof message.label === "string" && message.label.trim()
      ? message.label
      : isValidInstanceId(message.instanceId) ? undefined : `Chrome (pid ${process.pid})`;
    sendNative({ type: "hello", ok: true, host: "chrome-agent-bridge", version: VERSION, instanceId });
    queueRegistration({ instanceId, label });
    return;
  }
  if (message?.type === "instance.update" && instanceIdentity) {
    queueRegistration({ instanceId: instanceIdentity.instanceId, label: message.label });
    return;
  }
  if (message?.type === "event" && typeof message.event === "string") {
    recordEvent(message.event, message.data ?? {});
    return;
  }
  if (message?.type !== "response" || typeof message.id !== "string") return;

  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);

  if (message.ok === true) request.resolve(message.result);
  else {
    const error = new Error(message?.error?.message || "Chrome extension request failed");
    error.code = message?.error?.code || "extension_error";
    if (isDetails(message?.error?.details)) error.details = message.error.details;
    request.reject(error);
  }
}

const decoder = new NativeMessageDecoder();
process.stdin.on("data", (chunk) => {
  try {
    for (const message of decoder.push(chunk)) handleExtensionMessage(message);
  } catch (error) {
    log(`Invalid native message: ${error.message}`);
    process.exitCode = 1;
    void cleanup();
  }
});

async function handleRequest(request, response) {
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method !== "POST" || request.url !== "/rpc") {
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found" } }));
    return;
  }
  try {
    authState = await loadOrCreateAuthState();
  } catch (error) {
    response.statusCode = 500;
    response.end(JSON.stringify({ ok: false, error: serializeError(error, "auth_file_invalid") }));
    return;
  }
  if (!isAuthorized(request.headers.authorization, authState.token)) {
    response.statusCode = 401;
    response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }));
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) request.destroy();
  });
  request.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      if (typeof payload?.method !== "string" || payload.method.length > 100) {
        const error = new Error("Invalid RPC method");
        error.code = "invalid_request";
        throw error;
      }
      const result =
        payload.method === "events.poll"
          ? await pollEvents(payload.params ?? {})
          : await forwardToExtension(payload.method, payload.params ?? {});
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.statusCode = error?.code === "invalid_request" ? 400 : 502;
      response.end(JSON.stringify({ ok: false, error: serializeError(error) }));
    }
  });
}

const servers = [];

function listenOn(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function startBridgeServers() {
  const requested = await bridgeBindHosts();
  const wildcard = requested.find(isWildcardHost) ?? null;
  const explicit = requested.filter((host) => !isWildcardHost(host));

  // A wildcard bind already covers every interface, so it is never combined with
  // per-address sockets (which would collide with EADDRINUSE).
  const bindHosts = wildcard ? [wildcard] : explicit.length > 0 ? explicit : ["127.0.0.1"];

  // The first address that binds successfully fixes the shared port; the rest
  // reuse it so every reachable address serves the same RPC endpoint.
  // A port range lets several browser instances on one machine each take a free
  // port; the first host that binds fixes the port for the remaining addresses.
  const candidates = await bridgePortCandidates();
  let port = null;
  const boundHosts = [];
  for (const host of bindHosts) {
    for (const candidate of port == null ? candidates : [port]) {
      const server = http.createServer(handleRequest);
      try {
        await listenOn(server, candidate, host);
      } catch (error) {
        log(`Could not bind ${host}:${candidate}: ${error.message}`);
        server.close();
        continue;
      }
      servers.push(server);
      boundHosts.push(host);
      if (port == null) port = server.address().port;
      break;
    }
  }
  if (port == null) throw new Error("Could not bind any Chrome Agent Bridge address");

  // Wildcard binds are advertised as the concrete addresses a client can use.
  const advertised = wildcard
    ? ["127.0.0.1", ...localAddresses().map((record) => record.address)]
    : boundHosts;
  const hosts = [...new Set(advertised.filter((host) => !isWildcardHost(host)))];
  const host = hosts.includes("127.0.0.1") ? "127.0.0.1" : hosts[0];

  for (const address of hosts) {
    if (!isLoopbackHost(address)) {
      log(`WARNING: bridge RPC is reachable at ${address}:${port}; the bearer token is still required.`);
    }
  }

  const directory = bridgeDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  runtimeIdentity = {
    schemaVersion: 2,
    host,
    port,
    hosts,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await writePrivateJsonAtomic(runtimeFile(), runtimeIdentity);
  markRuntimeReady();
  sendNative({ type: "ready", ok: true, version: VERSION });
}

try {
  await startBridgeServers();
} catch (error) {
  log(`Failed to start bridge servers: ${error.message}`);
  process.exitCode = 1;
  await cleanup();
  // Exit instead of hanging connected-but-dead so the extension can reconnect a
  // fresh host rather than waiting forever on an unreachable RPC endpoint.
  process.exit(1);
}

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(new Error("Native host disconnected"));
  }
  pending.clear();
  for (const waiter of eventWaiters) {
    clearTimeout(waiter.timeout);
    waiter.resolve(eventResult(waiter.afterSequence, waiter.tabId));
  }
  eventWaiters.clear();
  for (const server of servers) server.close();
  if (instanceIdentity) {
    await removeInstanceRecord(instanceIdentity.instanceId, process.pid).catch((error) => {
      log(`Cleanup warning: ${error.message}`);
    });
  }
  try {
    const current = JSON.parse(await fs.readFile(runtimeFile(), "utf8"));
    if (current?.pid === runtimeIdentity?.pid && current?.port === runtimeIdentity?.port) {
      await fs.unlink(runtimeFile());
    }
  } catch (error) {
    if (error?.code !== "ENOENT") log(`Cleanup warning: ${error.message}`);
  }
}

process.stdin.on("end", () => void cleanup().finally(() => process.exit()));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit()));
process.on("SIGINT", () => void cleanup().finally(() => process.exit()));
