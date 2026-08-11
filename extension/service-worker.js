const HOST_NAME = "com.escape_wu.chrome_agent_bridge";
const MAX_SNAPSHOT_CHARS = 50_000;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;
const CDP_PROTOCOL_VERSION = "1.3";
const DEFAULT_NETWORK_MAX_EVENTS = 500;
const DEFAULT_NETWORK_MAX_BYTES = 1_000_000;
const MAX_NETWORK_EVENTS = 1_000;
const MAX_NETWORK_BYTES = 4_000_000;
const MAX_NETWORK_POLL_LIMIT = 200;
const DEFAULT_RAW_MAX_EVENTS = 500;
const DEFAULT_RAW_MAX_BYTES = 1_000_000;
const MAX_RAW_EVENTS = 1_000;
const MAX_RAW_BYTES = 3_000_000;
const MAX_RAW_POLL_LIMIT = 200;
const MAX_RAW_RESULT_BYTES = 3_000_000;
let nativePort = null;
let reconnectTimer = null;
let reconnectDelayMs = 1_000;
let nextAuthRequestId = 1;
const createdTabIds = new Set();
const pendingAuthRequests = new Map();
const networkSessions = new Map();
const networkSessionByTabId = new Map();
const rawSessions = new Map();
const rawSessionByTabId = new Map();
const rawSessionByChildSessionId = new Map();

function errorPayload(error, fallbackCode = "extension_error") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejectPendingAuthRequests(message) {
  for (const { reject, timeout } of pendingAuthRequests.values()) {
    clearTimeout(timeout);
    reject(codedError("bridge_offline", message));
  }
  pendingAuthRequests.clear();
}

function connect() {
  if (nativePort) return;
  try {
    const port = chrome.runtime.connectNative(HOST_NAME);
    nativePort = port;
    reconnectDelayMs = 1_000;
    port.onMessage.addListener((message) => void handleNativeMessage(message, port));
    port.onDisconnect.addListener(() => {
      nativePort = null;
      rejectPendingAuthRequests("Native host disconnected");
      scheduleReconnect();
    });
    port.postMessage({ type: "hello", extensionVersion: chrome.runtime.getManifest().version });
  } catch {
    nativePort = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
}

async function handleNativeMessage(message, port) {
  if (message?.type === "auth.response" && typeof message.id === "string") {
    const request = pendingAuthRequests.get(message.id);
    if (!request) return;
    pendingAuthRequests.delete(message.id);
    clearTimeout(request.timeout);
    if (message.ok === true) request.resolve(message.result);
    else request.reject(codedError(message?.error?.code || "auth_error", message?.error?.message || "Authentication request failed"));
    return;
  }
  if (message?.type !== "request" || typeof message.id !== "string") return;
  try {
    const result = await dispatch(message.method, message.params ?? {});
    port.postMessage({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    port.postMessage({
      type: "response",
      id: message.id,
      ok: false,
      error: errorPayload(error),
    });
  }
}

function requestAuth(action) {
  connect();
  if (!nativePort) {
    return Promise.reject(codedError("bridge_offline", "Native host is not available"));
  }
  const id = `auth-${nextAuthRequestId++}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingAuthRequests.delete(id);
      reject(codedError("auth_timeout", "Authentication request timed out"));
    }, AUTH_REQUEST_TIMEOUT_MS);
    pendingAuthRequests.set(id, { resolve, reject, timeout });
    try {
      nativePort.postMessage({ type: "auth.request", id, action });
    } catch (error) {
      clearTimeout(timeout);
      pendingAuthRequests.delete(id);
      reject(codedError("bridge_offline", error instanceof Error ? error.message : String(error)));
    }
  });
}

function emitBrowserEvent(event, data) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ type: "event", event, data });
  } catch {
    // The disconnect handler schedules reconnection.
  }
}

function safeUrl(value) {
  const url = new URL(value);
  const allowed = ["http:", "https:", "file:"];
  if (value === "about:blank") return value;
  if (!allowed.includes(url.protocol)) {
    throw codedError("unsafe_url", `Unsupported URL scheme: ${url.protocol}`);
  }
  return url.href;
}

function publicTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: Boolean(tab.active),
    title: tab.title || "",
    url: tab.url || "",
  };
}

async function requireTab(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw codedError("invalid_tab_id", "tabId must be a non-negative integer");
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    throw codedError("tab_not_found", `Chrome tab ${tabId} was not found`);
  }
}

function assertScriptable(tab) {
  const url = tab.url || "";
  if (!(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://"))) {
    throw codedError("restricted_page", `Cannot inspect or modify this page: ${url || "unknown URL"}`);
  }
}

async function activateTab(tabId) {
  const tab = await requireTab(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  return publicTab(await chrome.tabs.update(tabId, { active: true }));
}

async function execute(tabId, func, args = []) {
  const tab = await requireTab(tabId);
  assertScriptable(tab);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args,
  });
  if (result?.error) throw codedError(result.error.code, result.error.message);
  return result;
}

function snapshotPage(maxChars) {
  const isVisible = (element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
  };

  const selectorFor = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const siblings = [...current.parentElement.children].filter((child) => child.tagName === current.tagName);
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      segments.unshift(`${tag}${suffix}`);
      current = current.parentElement;
    }
    return segments.join(" > ");
  };

  const interactiveSelector = [
    "a[href]",
    "button",
    "input",
    "select",
    "textarea",
    "[role='button']",
    "[contenteditable='true']",
  ].join(",");

  const elements = [...document.querySelectorAll(interactiveSelector)]
    .filter(isVisible)
    .slice(0, 500)
    .map((element, index) => ({
      index,
      selector: selectorFor(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role"),
      type: element.getAttribute("type"),
      name:
        element.getAttribute("aria-label") ||
        element.getAttribute("name") ||
        element.innerText?.trim().slice(0, 160) ||
        element.getAttribute("placeholder") ||
        "",
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      checked: typeof element.checked === "boolean" ? element.checked : undefined,
    }));

  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").slice(0, maxChars),
    truncated: (document.body?.innerText || "").length > maxChars,
    elements,
  };
}

function clickElement(selector, confirmed) {
  const element = document.querySelector(selector);
  if (!element) return { error: { code: "selector_not_found", message: `No element matches ${selector}` } };
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  if (style.visibility === "hidden" || style.display === "none" || rect.width === 0 || rect.height === 0) {
    return { error: { code: "element_not_visible", message: `Element is not visible: ${selector}` } };
  }
  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { error: { code: "element_disabled", message: `Element is disabled: ${selector}` } };
  }
  const type = element.getAttribute("type")?.toLowerCase();
  const submitsForm =
    (element instanceof HTMLButtonElement && element.form && (!type || type === "submit")) ||
    (element instanceof HTMLInputElement && (type === "submit" || type === "image"));
  if (submitsForm && confirmed !== true) {
    return {
      error: {
        code: "confirmation_required",
        message: "This click may submit a form. Obtain explicit user confirmation and retry with confirmed=true.",
      },
    };
  }
  element.scrollIntoView({ block: "center", inline: "center" });
  element.click();
  return { clicked: true, selector };
}

function fillElement(selector, value) {
  const element = document.querySelector(selector);
  if (!element) return { error: { code: "selector_not_found", message: `No element matches ${selector}` } };
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
    return { error: { code: "password_field_rejected", message: "Password fields cannot be filled" } };
  }
  const fillable =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element.isContentEditable;
  if (!fillable) return { error: { code: "not_fillable", message: `Element cannot be filled: ${selector}` } };
  if (element.disabled || element.readOnly) {
    return { error: { code: "element_disabled", message: `Element is disabled or read-only: ${selector}` } };
  }

  element.focus();
  if (element.isContentEditable) element.textContent = value;
  else element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { filled: true, selector, length: value.length };
}

function integerParameter(value, name, { defaultValue, min, max }) {
  const parsed = value == null ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw codedError("invalid_request", `${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function sanitizeNetworkUrl(value) {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return `${url.protocol}`;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[unparseable-url]";
  }
}

function publicRequestId(session, requestId) {
  const key = String(requestId ?? "");
  let publicId = session.requestIds.get(key);
  if (!publicId) {
    publicId = `request-${session.nextPublicRequestId++}`;
    session.requestIds.set(key, publicId);
  }
  return publicId;
}

function networkEventFor(session, method, params) {
  const requestKey = String(params?.requestId ?? "");
  const known = session.requestMetadata.get(requestKey) || {};
  switch (method) {
    case "Network.requestWillBeSent": {
      const url = sanitizeNetworkUrl(params?.request?.url);
      const resourceType = String(params?.type || "Other").toLowerCase();
      session.requestMetadata.set(requestKey, { url, resourceType });
      return {
        kind: "request",
        requestId: publicRequestId(session, requestKey),
        url,
        method: String(params?.request?.method || "GET").slice(0, 32),
        resourceType,
        initiator: {
          type: String(params?.initiator?.type || "other").slice(0, 32),
          ...(params?.initiator?.url ? { url: sanitizeNetworkUrl(params.initiator.url) } : {}),
        },
      };
    }
    case "Network.responseReceived": {
      const url = sanitizeNetworkUrl(params?.response?.url);
      const resourceType = String(params?.type || known.resourceType || "Other").toLowerCase();
      session.requestMetadata.set(requestKey, { url, resourceType });
      return {
        kind: "response",
        requestId: publicRequestId(session, requestKey),
        url,
        status: Number.isFinite(params?.response?.status) ? params.response.status : undefined,
        mimeType: String(params?.response?.mimeType || "").slice(0, 160),
        protocol: String(params?.response?.protocol || "").slice(0, 40),
        resourceType,
        fromDiskCache: Boolean(params?.response?.fromDiskCache),
        fromServiceWorker: Boolean(params?.response?.fromServiceWorker),
      };
    }
    case "Network.loadingFinished": {
      const requestId = publicRequestId(session, requestKey);
      const event = {
        kind: "finished",
        requestId,
        url: known.url,
        resourceType: known.resourceType || "other",
        encodedDataLength: Number.isFinite(params?.encodedDataLength)
          ? Math.max(0, params.encodedDataLength)
          : undefined,
      };
      session.requestMetadata.delete(requestKey);
      session.requestIds.delete(requestKey);
      return event;
    }
    case "Network.loadingFailed": {
      const requestId = publicRequestId(session, requestKey);
      const event = {
        kind: "failed",
        requestId,
        url: known.url,
        resourceType: known.resourceType || "other",
        errorText: String(params?.errorText || "Network request failed").slice(0, 240),
        canceled: Boolean(params?.canceled),
        blockedReason: params?.blockedReason
          ? String(params.blockedReason).slice(0, 80)
          : undefined,
      };
      session.requestMetadata.delete(requestKey);
      session.requestIds.delete(requestKey);
      return event;
    }
    case "Network.webSocketCreated": {
      const url = sanitizeNetworkUrl(params?.url);
      session.requestMetadata.set(requestKey, { url, resourceType: "websocket" });
      return {
        kind: "websocket-created",
        requestId: publicRequestId(session, requestKey),
        url,
        resourceType: "websocket",
      };
    }
    case "Network.webSocketClosed": {
      const requestId = publicRequestId(session, requestKey);
      const event = {
        kind: "websocket-closed",
        requestId,
        url: known.url,
        resourceType: "websocket",
      };
      session.requestMetadata.delete(requestKey);
      session.requestIds.delete(requestKey);
      return event;
    }
    default:
      return null;
  }
}

function networkEventMatches(session, event) {
  if (session.resourceTypes.size > 0 && !session.resourceTypes.has(event.resourceType || "other")) {
    return false;
  }
  if (session.urlIncludes.length > 0) {
    return typeof event.url === "string" && session.urlIncludes.some((value) => event.url.includes(value));
  }
  return true;
}

function publicNetworkEvent(event) {
  const { byteLength, ...value } = event;
  return value;
}

function networkPollResult(session, afterCursor, limit) {
  const earliestCursor = session.events[0]?.cursor ?? session.latestCursor + 1;
  const matching = session.events.filter((event) => event.cursor > afterCursor);
  const selected = matching.slice(0, limit);
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    cursor: selected.at(-1)?.cursor ?? afterCursor,
    latestCursor: session.latestCursor,
    events: selected.map(publicNetworkEvent),
    hasMore: matching.length > selected.length,
    truncated: afterCursor < earliestCursor - 1,
    dropped: session.dropped,
  };
}

function resolveNetworkWaiters(session) {
  for (const waiter of [...session.waiters]) {
    const result = networkPollResult(session, waiter.afterCursor, waiter.limit);
    if (result.events.length === 0 && session.state === "running") continue;
    session.waiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  }
}

function recordNetworkEvent(session, event) {
  if (!event || !networkEventMatches(session, event)) return;
  const stored = {
    ...event,
    cursor: ++session.latestCursor,
    observedAt: new Date().toISOString(),
  };
  stored.byteLength = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
  if (stored.byteLength > session.maxBytes) {
    session.dropped += 1;
    resolveNetworkWaiters(session);
    return;
  }
  session.events.push(stored);
  session.totalBytes += stored.byteLength;
  while (session.events.length > session.maxEvents || session.totalBytes > session.maxBytes) {
    const removed = session.events.shift();
    session.totalBytes -= removed.byteLength;
    session.dropped += 1;
  }
  resolveNetworkWaiters(session);
}

function requireNetworkSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length < 20 || sessionId.length > 120) {
    throw codedError("invalid_request", "sessionId is invalid");
  }
  const session = networkSessions.get(sessionId);
  if (!session) throw codedError("network_session_not_found", "Network session was not found");
  return session;
}

async function startNetworkSession(params) {
  const tab = await requireTab(params.tabId);
  assertScriptable(tab);
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    throw codedError("network_not_supported", "Chrome debugger API is unavailable");
  }
  const existingId = networkSessionByTabId.get(params.tabId);
  const existing = existingId ? networkSessions.get(existingId) : null;
  if (existing?.state === "running") {
    throw codedError("network_session_exists", `A network session is already running for tab ${params.tabId}`);
  }
  if (rawSessionByTabId.has(params.tabId)) {
    throw codedError("debugger_target_busy", `A Raw CDP session already owns tab ${params.tabId}`);
  }

  const maxEvents = integerParameter(params.maxEvents, "maxEvents", {
    defaultValue: DEFAULT_NETWORK_MAX_EVENTS,
    min: 1,
    max: MAX_NETWORK_EVENTS,
  });
  const maxBytes = integerParameter(params.maxBytes, "maxBytes", {
    defaultValue: DEFAULT_NETWORK_MAX_BYTES,
    min: 65_536,
    max: MAX_NETWORK_BYTES,
  });
  const allowedTypes = new Set([
    "document", "stylesheet", "image", "media", "font", "script",
    "xhr", "fetch", "websocket", "other",
  ]);
  if (params.resourceTypes != null && !Array.isArray(params.resourceTypes)) {
    throw codedError("invalid_request", "resourceTypes must be an array");
  }
  const resourceTypes = new Set((params.resourceTypes || []).map((value) => String(value).toLowerCase()));
  if ([...resourceTypes].some((value) => !allowedTypes.has(value))) {
    throw codedError("invalid_request", "resourceTypes contains an unsupported value");
  }
  const urlIncludes = Array.isArray(params.urlIncludes) ? params.urlIncludes : [];
  if (urlIncludes.length > 20 || urlIncludes.some((value) => typeof value !== "string" || value.length > 200)) {
    throw codedError("invalid_request", "urlIncludes must contain at most 20 strings of 200 characters or fewer");
  }

  const session = {
    id: `net_${crypto.randomUUID()}`,
    tabId: params.tabId,
    state: "starting",
    createdAt: new Date().toISOString(),
    maxEvents,
    maxBytes,
    resourceTypes,
    urlIncludes,
    events: [],
    totalBytes: 0,
    latestCursor: 0,
    dropped: 0,
    requestIds: new Map(),
    requestMetadata: new Map(),
    nextPublicRequestId: 1,
    waiters: new Set(),
  };
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId: params.tabId }, CDP_PROTOCOL_VERSION);
    attached = true;
    await chrome.debugger.sendCommand({ tabId: params.tabId }, "Network.enable", {
      maxTotalBufferSize: maxBytes,
      maxResourceBufferSize: Math.min(maxBytes, 1_000_000),
    });
  } catch (error) {
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId: params.tabId });
      } catch {
        // Ignore cleanup failure after an enable error.
      }
    }
    throw codedError(
      "network_permission_denied",
      error instanceof Error ? error.message : "Chrome refused the network debugging session",
    );
  }
  session.state = "running";
  networkSessions.set(session.id, session);
  networkSessionByTabId.set(session.tabId, session.id);
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    cursor: 0,
    createdAt: session.createdAt,
    limits: { maxEvents, maxBytes },
  };
}

function pollNetworkSession(params) {
  const session = requireNetworkSession(params.sessionId);
  const afterCursor = integerParameter(params.afterCursor, "afterCursor", {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const limit = integerParameter(params.limit, "limit", {
    defaultValue: 100,
    min: 1,
    max: MAX_NETWORK_POLL_LIMIT,
  });
  const timeoutMs = integerParameter(params.timeoutMs, "timeoutMs", {
    defaultValue: 10_000,
    min: 0,
    max: 25_000,
  });
  const current = networkPollResult(session, afterCursor, limit);
  if (current.events.length > 0 || timeoutMs === 0 || session.state !== "running") {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const waiter = { afterCursor, limit, resolve };
    waiter.timeout = setTimeout(() => {
      session.waiters.delete(waiter);
      resolve(networkPollResult(session, afterCursor, limit));
    }, timeoutMs);
    session.waiters.add(waiter);
  });
}

async function stopNetworkSession(params) {
  const session = requireNetworkSession(params.sessionId);
  if (session.state !== "stopped") {
    const wasRunning = session.state === "running";
    session.state = "stopping";
    if (wasRunning) {
      try {
        await chrome.debugger.sendCommand({ tabId: session.tabId }, "Network.disable");
      } catch {
        // The tab or debugger may already be gone.
      }
      try {
        await chrome.debugger.detach({ tabId: session.tabId });
      } catch {
        // Detach is idempotent from the caller's perspective.
      }
    }
    session.state = "stopped";
    networkSessionByTabId.delete(session.tabId);
    resolveNetworkWaiters(session);
  }
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    finalCursor: session.latestCursor,
    dropped: session.dropped,
    stoppedAt: new Date().toISOString(),
  };
}

function handleDebuggerEvent(source, method, params) {
  if (handleRawDebuggerEvent(source, method, params)) return;
  if (!Number.isInteger(source?.tabId)) return;
  const sessionId = networkSessionByTabId.get(source.tabId);
  const session = sessionId ? networkSessions.get(sessionId) : null;
  if (!session || session.state !== "running") return;
  recordNetworkEvent(session, networkEventFor(session, method, params ?? {}));
}

function handleDebuggerDetach(source) {
  if (handleRawDebuggerDetach(source)) return;
  if (!Number.isInteger(source?.tabId)) return;
  const sessionId = networkSessionByTabId.get(source.tabId);
  const session = sessionId ? networkSessions.get(sessionId) : null;
  if (!session) return;
  session.state = "detached";
  networkSessionByTabId.delete(source.tabId);
  resolveNetworkWaiters(session);
}

function requireRawSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length < 20 || sessionId.length > 120) {
    throw codedError("raw_invalid_request", "sessionId is invalid");
  }
  const session = rawSessions.get(sessionId);
  if (!session) throw codedError("raw_session_not_found", "Raw CDP session was not found");
  return session;
}

function rawPollResult(session, afterCursor, limit) {
  const earliestCursor = session.events[0]?.cursor ?? session.latestCursor + 1;
  const matching = session.events.filter((event) => event.cursor > afterCursor);
  const selected = matching.slice(0, limit);
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    cursor: selected.at(-1)?.cursor ?? afterCursor,
    latestCursor: session.latestCursor,
    events: selected.map(publicNetworkEvent),
    hasMore: matching.length > selected.length,
    truncated: afterCursor < earliestCursor - 1,
    dropped: session.dropped,
  };
}

function resolveRawWaiters(session) {
  for (const waiter of [...session.waiters]) {
    const result = rawPollResult(session, waiter.afterCursor, waiter.limit);
    if (result.events.length === 0 && session.state === "running") continue;
    session.waiters.delete(waiter);
    clearTimeout(waiter.timeout);
    waiter.resolve(result);
  }
}

function recordRawEvent(session, source, method, params) {
  const stored = {
    cursor: ++session.latestCursor,
    observedAt: new Date().toISOString(),
    source,
    method,
    params,
  };
  stored.byteLength = new TextEncoder().encode(JSON.stringify(stored)).byteLength;
  if (stored.byteLength > session.maxBytes) {
    session.dropped += 1;
    resolveRawWaiters(session);
    return;
  }
  session.events.push(stored);
  session.totalBytes += stored.byteLength;
  while (session.events.length > session.maxEvents || session.totalBytes > session.maxBytes) {
    const removed = session.events.shift();
    session.totalBytes -= removed.byteLength;
    session.dropped += 1;
  }
  resolveRawWaiters(session);
}

function registerRawChildSession(session, childSessionId) {
  if (typeof childSessionId !== "string" || childSessionId.length === 0) return;
  session.childSessionIds.add(childSessionId);
  rawSessionByChildSessionId.set(childSessionId, session.id);
}

function unregisterRawChildSession(session, childSessionId) {
  if (typeof childSessionId !== "string" || childSessionId.length === 0) return;
  session.childSessionIds.delete(childSessionId);
  if (rawSessionByChildSessionId.get(childSessionId) === session.id) {
    rawSessionByChildSessionId.delete(childSessionId);
  }
}

async function attachRawSession(params) {
  const tab = await requireTab(params.tabId);
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    throw codedError("raw_cdp_not_supported", "Chrome debugger API is unavailable");
  }
  if (networkSessionByTabId.has(params.tabId) || rawSessionByTabId.has(params.tabId)) {
    throw codedError("debugger_target_busy", `A debugger session already owns tab ${params.tabId}`);
  }
  const maxEvents = integerParameter(params.maxEvents, "maxEvents", {
    defaultValue: DEFAULT_RAW_MAX_EVENTS,
    min: 1,
    max: MAX_RAW_EVENTS,
  });
  const maxBytes = integerParameter(params.maxBytes, "maxBytes", {
    defaultValue: DEFAULT_RAW_MAX_BYTES,
    min: 65_536,
    max: MAX_RAW_BYTES,
  });
  const session = {
    id: `raw_${crypto.randomUUID()}`,
    tabId: tab.id,
    state: "starting",
    createdAt: new Date().toISOString(),
    maxEvents,
    maxBytes,
    events: [],
    totalBytes: 0,
    latestCursor: 0,
    dropped: 0,
    waiters: new Set(),
    childSessionIds: new Set(),
  };
  try {
    await chrome.debugger.attach({ tabId: session.tabId }, CDP_PROTOCOL_VERSION);
  } catch (error) {
    throw codedError(
      "raw_permission_denied",
      error instanceof Error ? error.message : "Chrome refused the Raw CDP session",
    );
  }
  session.state = "running";
  rawSessions.set(session.id, session);
  rawSessionByTabId.set(session.tabId, session.id);
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    cursor: 0,
    createdAt: session.createdAt,
    limits: { maxEvents, maxBytes, maxResultBytes: MAX_RAW_RESULT_BYTES },
  };
}

async function sendRawCommand(params) {
  const session = requireRawSession(params.sessionId);
  if (session.state !== "running") {
    throw codedError("raw_session_detached", `Raw CDP session is ${session.state}`);
  }
  if (typeof params.method !== "string" || params.method.length === 0 || params.method.length > 200) {
    throw codedError("raw_invalid_request", "method must be a string from 1 to 200 characters");
  }
  if (params.params != null && (typeof params.params !== "object" || Array.isArray(params.params))) {
    throw codedError("raw_invalid_request", "params must be a JSON object when provided");
  }
  const targetSessionId = params.targetSessionId;
  if (targetSessionId != null) {
    if (typeof targetSessionId !== "string" || !session.childSessionIds.has(targetSessionId)) {
      throw codedError("raw_target_not_found", "targetSessionId is not attached to this Raw CDP session");
    }
  }
  const target = targetSessionId ? { sessionId: targetSessionId } : { tabId: session.tabId };
  try {
    const result = await chrome.debugger.sendCommand(target, params.method, params.params ?? {});
    if (params.method === "Target.attachToTarget" && typeof result?.sessionId === "string") {
      registerRawChildSession(session, result.sessionId);
    } else if (params.method === "Target.detachFromTarget") {
      unregisterRawChildSession(session, params.params?.sessionId);
    }
    const response = { result: result ?? null };
    const byteLength = new TextEncoder().encode(JSON.stringify(response)).byteLength;
    if (byteLength > MAX_RAW_RESULT_BYTES) {
      throw codedError(
        "raw_result_too_large",
        `Raw CDP result exceeds the ${MAX_RAW_RESULT_BYTES}-byte transport limit`,
      );
    }
    return response;
  } catch (error) {
    if (typeof error?.code === "string" && error.code.startsWith("raw_")) throw error;
    throw codedError("raw_cdp_error", error instanceof Error ? error.message : String(error));
  }
}

function pollRawSession(params) {
  const session = requireRawSession(params.sessionId);
  const afterCursor = integerParameter(params.afterCursor, "afterCursor", {
    defaultValue: 0,
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const limit = integerParameter(params.limit, "limit", {
    defaultValue: 100,
    min: 1,
    max: MAX_RAW_POLL_LIMIT,
  });
  const timeoutMs = integerParameter(params.timeoutMs, "timeoutMs", {
    defaultValue: 10_000,
    min: 0,
    max: 25_000,
  });
  const current = rawPollResult(session, afterCursor, limit);
  if (current.events.length > 0 || timeoutMs === 0 || session.state !== "running") {
    return Promise.resolve(current);
  }
  return new Promise((resolve) => {
    const waiter = { afterCursor, limit, resolve };
    waiter.timeout = setTimeout(() => {
      session.waiters.delete(waiter);
      resolve(rawPollResult(session, afterCursor, limit));
    }, timeoutMs);
    session.waiters.add(waiter);
  });
}

async function detachRawSession(params) {
  const session = requireRawSession(params.sessionId);
  if (session.state !== "stopped") {
    const wasRunning = session.state === "running";
    session.state = "stopping";
    if (wasRunning) {
      try {
        await chrome.debugger.detach({ tabId: session.tabId });
      } catch {
        // The target may already be detached or closed.
      }
    }
    session.state = "stopped";
    rawSessionByTabId.delete(session.tabId);
    for (const childSessionId of session.childSessionIds) {
      unregisterRawChildSession(session, childSessionId);
    }
    resolveRawWaiters(session);
  }
  return {
    sessionId: session.id,
    tabId: session.tabId,
    state: session.state,
    finalCursor: session.latestCursor,
    dropped: session.dropped,
    detachedAt: new Date().toISOString(),
  };
}

function rawSessionForSource(source) {
  const rootSessionId = Number.isInteger(source?.tabId)
    ? rawSessionByTabId.get(source.tabId)
    : undefined;
  const childSessionId = typeof source?.sessionId === "string"
    ? rawSessionByChildSessionId.get(source.sessionId)
    : undefined;
  return rawSessions.get(rootSessionId || childSessionId);
}

function handleRawDebuggerEvent(source, method, params) {
  const session = rawSessionForSource(source);
  if (!session || session.state !== "running") return false;
  if (method === "Target.attachedToTarget") registerRawChildSession(session, params?.sessionId);
  if (method === "Target.detachedFromTarget") unregisterRawChildSession(session, params?.sessionId);
  recordRawEvent(session, source, method, params ?? {});
  return true;
}

function handleRawDebuggerDetach(source) {
  const session = rawSessionForSource(source);
  if (!session) return false;
  if (typeof source?.sessionId === "string" && !Number.isInteger(source?.tabId)) {
    unregisterRawChildSession(session, source.sessionId);
    return true;
  }
  session.state = "detached";
  rawSessionByTabId.delete(session.tabId);
  for (const childSessionId of session.childSessionIds) {
    unregisterRawChildSession(session, childSessionId);
  }
  resolveRawWaiters(session);
  return true;
}

async function dispatch(method, params) {
  switch (method) {
    case "browser.status":
      return { connected: true, extensionVersion: chrome.runtime.getManifest().version };
    case "tabs.list": {
      const tabs = await chrome.tabs.query({});
      return tabs
        .filter((tab) => tab.url && /^(https?:|file:|about:blank)/.test(tab.url))
        .map(publicTab);
    }
    case "tabs.create": {
      const tab = await chrome.tabs.create({ url: safeUrl(params.url || "about:blank"), active: params.active !== false });
      if (Number.isInteger(tab.id)) createdTabIds.add(tab.id);
      return publicTab(tab);
    }
    case "tabs.close": {
      await requireTab(params.tabId);
      if (!createdTabIds.has(params.tabId)) {
        throw codedError("tab_not_owned", "Only tabs created by Chrome Agent Bridge can be closed");
      }
      await chrome.tabs.remove(params.tabId);
      createdTabIds.delete(params.tabId);
      return { closed: true, tabId: params.tabId };
    }
    case "tabs.activate":
      return activateTab(params.tabId);
    case "tabs.navigate": {
      await requireTab(params.tabId);
      return publicTab(await chrome.tabs.update(params.tabId, { url: safeUrl(params.url) }));
    }
    case "page.snapshot":
      return execute(params.tabId, snapshotPage, [Math.min(params.maxChars || MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_CHARS)]);
    case "page.screenshot": {
      const tab = await requireTab(params.tabId);
      await activateTab(params.tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, tabId: params.tabId };
    }
    case "page.click":
      return execute(params.tabId, clickElement, [params.selector, params.confirmed === true]);
    case "page.fill":
      return execute(params.tabId, fillElement, [params.selector, params.value]);
    case "network.start":
      return startNetworkSession(params);
    case "network.poll":
      return pollNetworkSession(params);
    case "network.stop":
      return stopNetworkSession(params);
    case "raw.attach":
      return attachRawSession(params);
    case "raw.send":
      return sendRawCommand(params);
    case "raw.poll":
      return pollRawSession(params);
    case "raw.detach":
      return detachRawSession(params);
    default:
      throw codedError("method_not_found", `Unsupported method: ${method}`);
  }
}

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
chrome.action.onClicked.addListener(connect);
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const action = message?.type === "auth.get"
    ? "get"
    : message?.type === "auth.renew"
      ? "renew"
      : null;
  if (!action) return false;
  void requestAuth(action).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: errorPayload(error, "auth_error") }),
  );
  return true;
});
chrome.tabs.onCreated.addListener((tab) => emitBrowserEvent("tab.created", publicTab(tab)));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) =>
  emitBrowserEvent("tab.updated", {
    tabId,
    changeInfo: {
      status: changeInfo.status,
      title: changeInfo.title,
      url: changeInfo.url,
    },
    tab: publicTab(tab),
  }),
);
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  createdTabIds.delete(tabId);
  const sessionId = networkSessionByTabId.get(tabId);
  const session = sessionId ? networkSessions.get(sessionId) : null;
  if (session) {
    session.state = "detached";
    networkSessionByTabId.delete(tabId);
    resolveNetworkWaiters(session);
  }
  const rawSessionId = rawSessionByTabId.get(tabId);
  const rawSession = rawSessionId ? rawSessions.get(rawSessionId) : null;
  if (rawSession) {
    rawSession.state = "detached";
    rawSessionByTabId.delete(tabId);
    for (const childSessionId of rawSession.childSessionIds) {
      unregisterRawChildSession(rawSession, childSessionId);
    }
    resolveRawWaiters(rawSession);
  }
  emitBrowserEvent("tab.removed", { tabId, ...removeInfo });
});
chrome.tabs.onActivated.addListener((activeInfo) => emitBrowserEvent("tab.activated", activeInfo));
chrome.debugger?.onEvent?.addListener(handleDebuggerEvent);
chrome.debugger?.onDetach?.addListener(handleDebuggerDetach);
connect();
