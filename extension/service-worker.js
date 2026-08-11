const HOST_NAME = "com.escape_wu.chrome_agent_bridge";
const MAX_SNAPSHOT_CHARS = 50_000;
const AUTH_REQUEST_TIMEOUT_MS = 5_000;
let nativePort = null;
let reconnectTimer = null;
let reconnectDelayMs = 1_000;
let nextAuthRequestId = 1;
const createdTabIds = new Set();
const pendingAuthRequests = new Map();

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
  emitBrowserEvent("tab.removed", { tabId, ...removeInfo });
});
chrome.tabs.onActivated.addListener((activeInfo) => emitBrowserEvent("tab.activated", activeInfo));
connect();
