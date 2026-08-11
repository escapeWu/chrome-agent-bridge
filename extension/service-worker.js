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
const pageSnapshotsByTabId = new Map();
const pageActionChains = new Map();

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
  const interactiveRoles = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox",
    "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
  ]);
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (element.closest("[aria-hidden='true'],[inert]")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" &&
      rect.width > 0 && rect.height > 0;
  };

  const selectorFor = (element) => {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const testId = element.getAttribute("data-testid");
    if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
    const segments = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body && segments.length < 8) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter((child) => child.tagName === current.tagName)
        : [];
      const suffix = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : "";
      segments.unshift(`${tag}${suffix}`);
      current = current.parentElement;
    }
    return segments.join(" > ");
  };

  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag !== "input") return "";
    const type = String(element.type || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "hidden") return "";
    return "textbox";
  };

  const accessibleName = (element) => {
    const labelledBy = normalize(element.getAttribute("aria-labelledby"));
    const labelledText = labelledBy
      ? labelledBy.split(" ").map((id) => normalize(document.getElementById(id)?.textContent)).filter(Boolean).join(" ")
      : "";
    const labels = element.labels ? [...element.labels].map((label) => normalize(label.textContent)).filter(Boolean).join(" ") : "";
    const inputValue = element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)
      ? element.value
      : "";
    return normalize(
      element.getAttribute("aria-label") || labelledText || labels || element.getAttribute("alt") ||
      inputValue || element.innerText || element.getAttribute("placeholder") ||
      element.getAttribute("title") || element.getAttribute("name") || "",
    ).slice(0, 160);
  };

  const roleSelector = [...interactiveRoles].map((role) => `[role="${role}"]`).join(",");
  const interactiveSelector = [
    "a[href]", "button", "summary", "input:not([type='hidden'])", "select", "textarea",
    "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])", roleSelector,
  ].join(",");
  const roleNameCounts = new Map();
  const snapshotLines = [];
  const elements = [];

  for (const element of [...document.querySelectorAll(interactiveSelector)].filter(isVisible).slice(0, 500)) {
    const role = element.getAttribute("role") || implicitRole(element) || "generic";
    if (element.hasAttribute("role") && !interactiveRoles.has(role) && !element.matches("[tabindex]:not([tabindex='-1'])")) {
      continue;
    }
    const name = accessibleName(element);
    const countKey = `${role}\u0000${name}`;
    const nth = roleNameCounts.get(countKey) || 0;
    roleNameCounts.set(countKey, nth + 1);
    const ref = `e${elements.length + 1}`;
    const selector = selectorFor(element);
    const disabled = Boolean(element.disabled || element.getAttribute("aria-disabled") === "true");
    const checked = typeof element.checked === "boolean" ? element.checked : undefined;
    const selected = element.getAttribute("aria-selected") === "true" ||
      (element instanceof HTMLOptionElement ? element.selected : undefined);
    const expandedValue = element.getAttribute("aria-expanded");
    const expanded = expandedValue == null ? undefined : expandedValue === "true";
    const locator = {
      selector,
      role,
      name,
      nth,
      id: element.id || undefined,
      testId: element.getAttribute("data-testid") || undefined,
      tag: element.tagName.toLowerCase(),
      type: element.getAttribute("type") || undefined,
    };
    elements.push({
      index: elements.length,
      ref,
      selector,
      tag: locator.tag,
      role,
      type: locator.type,
      name,
      disabled,
      checked,
      selected,
      expanded,
      _locator: locator,
    });
    const states = [
      disabled ? "disabled" : "",
      checked === true ? "checked" : checked === false && ["checkbox", "radio", "switch"].includes(role) ? "checked=false" : "",
      selected === true ? "selected" : "",
      expanded === true ? "expanded" : expanded === false ? "expanded=false" : "",
    ].filter(Boolean);
    snapshotLines.push(`- ${role}${name ? ` "${name.replace(/"/g, '\\"')}"` : ""} [ref=${ref}]${states.length ? ` [${states.join(", ")}]` : ""}`);
  }

  return {
    title: document.title,
    url: location.href,
    text: (document.body?.innerText || "").slice(0, maxChars),
    truncated: (document.body?.innerText || "").length > maxChars,
    snapshot: snapshotLines.join("\n"),
    elements,
  };
}

async function prepareActionTarget(locator, marker, kind, confirmed) {
  const interactiveRoles = new Set([
    "button", "checkbox", "combobox", "link", "listbox", "menuitem",
    "menuitemcheckbox", "menuitemradio", "option", "radio", "searchbox",
    "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
  ]);
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const isVisible = (element) => {
    if (element.closest("[aria-hidden='true'],[inert]")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0" &&
      rect.width > 0 && rect.height > 0;
  };
  const implicitRole = (element) => {
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea" || element.isContentEditable) return "textbox";
    if (tag !== "input") return "";
    const type = String(element.type || "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(type)) return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (type === "search") return "searchbox";
    if (type === "hidden") return "";
    return "textbox";
  };
  const accessibleName = (element) => {
    const labelledBy = normalize(element.getAttribute("aria-labelledby"));
    const labelledText = labelledBy
      ? labelledBy.split(" ").map((id) => normalize(document.getElementById(id)?.textContent)).filter(Boolean).join(" ")
      : "";
    const labels = element.labels ? [...element.labels].map((label) => normalize(label.textContent)).filter(Boolean).join(" ") : "";
    const inputValue = element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)
      ? element.value
      : "";
    return normalize(
      element.getAttribute("aria-label") || labelledText || labels || element.getAttribute("alt") ||
      inputValue || element.innerText || element.getAttribute("placeholder") ||
      element.getAttribute("title") || element.getAttribute("name") || "",
    ).slice(0, 160);
  };
  const candidateSelector = [
    "a[href]", "button", "summary", "input:not([type='hidden'])", "select", "textarea",
    "[contenteditable='true']", "[tabindex]:not([tabindex='-1'])",
    ...[...interactiveRoles].map((role) => `[role="${role}"]`),
  ].join(",");
  const roleMatches = locator.role
    ? [...document.querySelectorAll(candidateSelector)].filter((element) =>
      isVisible(element) &&
      (element.getAttribute("role") || implicitRole(element) || "generic") === locator.role &&
      accessibleName(element) === locator.name)
    : [];
  let element = roleMatches[locator.nth || 0];
  if (!element && locator.id) element = document.getElementById(locator.id);
  if (!element && locator.testId) {
    element = [...document.querySelectorAll("[data-testid]")]
      .find((candidate) => candidate.getAttribute("data-testid") === locator.testId);
  }
  if (!element && locator.selector) {
    try {
      element = document.querySelector(locator.selector);
    } catch {
      return { error: { code: "invalid_selector", message: `Invalid selector: ${locator.selector}` } };
    }
  }
  if (!element) {
    return { error: { code: "action_target_not_found", message: "The action target is no longer present. Take a fresh snapshot." } };
  }
  let rect = element.getBoundingClientRect();
  if (!isVisible(element)) {
    return { error: { code: "element_not_visible", message: "The action target is not visible. Take a fresh snapshot." } };
  }
  if (element.disabled || element.getAttribute("aria-disabled") === "true") {
    return { error: { code: "element_disabled", message: "The action target is disabled." } };
  }
  if (kind === "click") {
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
  }
  if (kind === "fill") {
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") {
      return { error: { code: "password_field_rejected", message: "Password fields cannot be filled" } };
    }
    const fillable = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element.isContentEditable;
    if (!fillable) return { error: { code: "not_fillable", message: "The action target cannot be filled." } };
    if (element.readOnly) return { error: { code: "element_disabled", message: "The action target is read-only." } };
  }
  if (kind === "select" && !(element instanceof HTMLSelectElement)) {
    return { error: { code: "not_selectable", message: "select is only for native <select> elements; click a custom option ref instead." } };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, 500);
    requestAnimationFrame(() => requestAnimationFrame(finish));
  });
  rect = element.getBoundingClientRect();
  element.setAttribute("data-cab-action-target", marker);
  if (["fill", "press", "select"].includes(kind)) element.focus();
  const points = [
    [rect.left + rect.width / 2, rect.top + rect.height / 2],
    [rect.left + rect.width / 4, rect.top + rect.height / 2],
    [rect.left + rect.width * 3 / 4, rect.top + rect.height / 2],
    [rect.left + rect.width / 2, rect.top + rect.height / 4],
    [rect.left + rect.width / 2, rect.top + rect.height * 3 / 4],
  ];
  const point = points.find(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return hit && (hit === element || element.contains(hit));
  });
  if (kind === "click" && !point) {
    element.removeAttribute("data-cab-action-target");
    return { error: { code: "element_not_receiving_pointer", message: "Another element covers the action target." } };
  }
  return {
    marker,
    x: point?.[0],
    y: point?.[1],
    target: {
      role: element.getAttribute("role") || implicitRole(element) || "generic",
      name: accessibleName(element),
      tag: element.tagName.toLowerCase(),
    },
  };
}

function inspectPreparedTarget(marker, x, y) {
  const element = document.querySelector(`[data-cab-action-target="${marker}"]`);
  if (!element) return { ok: false, reason: "target_removed" };
  const hit = document.elementFromPoint(x, y);
  return {
    ok: Boolean(hit && (hit === element || element.contains(hit))),
    hit: hit ? { tag: hit.tagName.toLowerCase(), role: hit.getAttribute("role"), text: String(hit.innerText || "").trim().slice(0, 80) } : null,
  };
}

function performPreparedDomAction(marker, kind, value) {
  const element = document.querySelector(`[data-cab-action-target="${marker}"]`);
  if (!element) return { error: { code: "action_target_not_found", message: "The action target disappeared." } };
  if (kind === "fill") {
    if (element.isContentEditable) {
      element.textContent = value;
    } else {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (!setter) return { error: { code: "not_fillable", message: "The action target has no native value setter." } };
      setter.call(element, value);
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true, length: value.length };
  }
  if (kind === "select") {
    const values = Array.isArray(value) ? value.map(String) : [String(value)];
    const matched = [];
    for (const option of element.options) {
      const selected = values.includes(option.value) || values.includes(String(option.label || option.text).trim());
      option.selected = selected;
      if (selected) matched.push(option.value);
      if (selected && !element.multiple) break;
    }
    if (matched.length === 0) {
      return { error: { code: "option_not_found", message: "No native option matches the requested value or label." } };
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: true, values: matched };
  }
  return { error: { code: "invalid_action", message: `Unsupported DOM action: ${kind}` } };
}

function cleanupPreparedTarget(marker) {
  const element = document.querySelector(`[data-cab-action-target="${marker}"]`);
  if (element) element.removeAttribute("data-cab-action-target");
  return { cleaned: Boolean(element) };
}

async function snapshotTab(tabId, maxChars) {
  const result = await execute(tabId, snapshotPage, [maxChars]);
  const snapshotId = `snapshot_${crypto.randomUUID()}`;
  const refs = new Map();
  const elements = (result?.elements || []).map((element) => {
    if (typeof element.ref === "string" && element._locator) refs.set(element.ref, element._locator);
    const { _locator, ...publicElement } = element;
    return publicElement;
  });
  pageSnapshotsByTabId.set(tabId, {
    id: snapshotId,
    url: result.url,
    refs,
    createdAt: new Date().toISOString(),
  });
  return {
    ...result,
    elements,
    snapshotId,
    refCount: refs.size,
  };
}

async function actionLocator(tabId, params) {
  if (params.ref != null) {
    if (typeof params.ref !== "string" || !/^e\d+$/.test(params.ref)) {
      throw codedError("invalid_ref", "ref must look like e1, e2, and so on");
    }
    const snapshot = pageSnapshotsByTabId.get(tabId);
    if (!snapshot) {
      throw codedError("stale_ref", "No current snapshot exists for this tab. Take browser_snapshot and retry.");
    }
    const tab = await requireTab(tabId);
    if (tab.url !== snapshot.url) {
      pageSnapshotsByTabId.delete(tabId);
      throw codedError("stale_ref", "The tab navigated after the snapshot. Take a fresh browser_snapshot and retry.");
    }
    const locator = snapshot.refs.get(params.ref);
    if (!locator) {
      throw codedError("stale_ref", `Unknown ref ${params.ref}. Take a fresh browser_snapshot and retry.`);
    }
    return { ...locator, ref: params.ref, snapshotId: snapshot.id };
  }
  if (typeof params.selector === "string" && params.selector.length > 0 && params.selector.length <= 2_000) {
    return { selector: params.selector };
  }
  throw codedError("invalid_action", "The action requires a ref from the latest snapshot or a CSS selector");
}

function bridgeOwnsDebugger(tabId) {
  const rawSession = rawSessions.get(rawSessionByTabId.get(tabId));
  if (rawSession?.state === "running") return true;
  const networkSession = networkSessions.get(networkSessionByTabId.get(tabId));
  return networkSession?.state === "running";
}

async function withPageDebugger(tabId, operation) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand) {
    throw codedError("page_control_not_supported", "Chrome debugger API is unavailable");
  }
  const reuseAttachment = bridgeOwnsDebugger(tabId);
  let attached = false;
  try {
    if (!reuseAttachment) {
      await chrome.debugger.attach({ tabId }, CDP_PROTOCOL_VERSION);
      attached = true;
    }
    return await operation({ tabId });
  } catch (error) {
    if (typeof error?.code === "string") throw error;
    throw codedError("page_control_cdp_error", error instanceof Error ? error.message : String(error));
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // The tab may have closed during the action.
      }
    }
  }
}

function keyDescriptor(input) {
  const aliases = { Space: " ", Spacebar: " ", Esc: "Escape", Down: "ArrowDown", Up: "ArrowUp", Left: "ArrowLeft", Right: "ArrowRight" };
  const key = aliases[input] || input;
  const known = {
    Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
    Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
    Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
    End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
    PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
    " ": { key: " ", code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (known[key]) return known[key];
  if (typeof key === "string" && [...key].length === 1) {
    const upper = key.toUpperCase();
    return { key, code: /^[A-Z]$/.test(upper) ? `Key${upper}` : "", windowsVirtualKeyCode: upper.codePointAt(0), text: key };
  }
  throw codedError("unsupported_key", `Unsupported key: ${String(input)}`);
}

function serializePageAction(tabId, operation) {
  const previous = pageActionChains.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  pageActionChains.set(tabId, current);
  return current.finally(() => {
    if (pageActionChains.get(tabId) === current) pageActionChains.delete(tabId);
  });
}

async function pageAction(params) {
  const allowedKinds = new Set(["click", "fill", "press", "select"]);
  if (!allowedKinds.has(params.kind)) {
    throw codedError("invalid_action", "kind must be click, fill, press, or select");
  }
  const tab = await requireTab(params.tabId);
  assertScriptable(tab);
  return serializePageAction(params.tabId, async () => {
    const locator = await actionLocator(params.tabId, params);
    const marker = `cab-${crypto.randomUUID()}`;
    let prepared = null;
    try {
      if (params.kind === "click") {
        const result = await withPageDebugger(params.tabId, async (target) => {
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            prepared = await execute(params.tabId, prepareActionTarget, [locator, marker, "click", params.confirmed === true]);
            const hit = await execute(params.tabId, inspectPreparedTarget, [marker, prepared.x, prepared.y]);
            if (!hit?.ok) {
              if (attempt < 2) {
                await execute(params.tabId, cleanupPreparedTarget, [marker]);
                continue;
              }
              throw codedError("action_target_moved", `The target moved before click (${hit?.reason || "hit test changed"}). Take a fresh snapshot.`);
            }
            await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
              type: "mouseMoved", x: prepared.x, y: prepared.y, button: "none", buttons: 0,
            });
            const hovered = await execute(params.tabId, inspectPreparedTarget, [marker, prepared.x, prepared.y]);
            if (!hovered?.ok) {
              if (attempt < 2) {
                await execute(params.tabId, cleanupPreparedTarget, [marker]);
                continue;
              }
              throw codedError("action_target_moved", "Hover moved or covered the target before mouse press. Take a fresh snapshot.");
            }
            let mouseDown = false;
            try {
              await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                type: "mousePressed", x: prepared.x, y: prepared.y, button: "left", buttons: 1, clickCount: 1,
              });
              mouseDown = true;
              await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                type: "mouseReleased", x: prepared.x, y: prepared.y, button: "left", buttons: 0, clickCount: 1,
              });
              mouseDown = false;
              return { clicked: true, point: { x: prepared.x, y: prepared.y }, target: prepared.target, attempts: attempt };
            } finally {
              if (mouseDown) {
                try {
                  await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
                    type: "mouseReleased", x: prepared.x, y: prepared.y, button: "left", buttons: 0, clickCount: 1,
                  });
                } catch {
                  // Avoid masking the original failure while releasing a potentially held button.
                }
              }
            }
          }
          throw codedError("action_target_moved", "The click target could not be stabilized.");
        });
        pageSnapshotsByTabId.delete(params.tabId);
        return { ...result, ref: params.ref, snapshotId: locator.snapshotId, needsSnapshot: true };
      }

      prepared = await execute(params.tabId, prepareActionTarget, [locator, marker, params.kind, params.confirmed === true]);
      if (params.kind === "press") {
        if (typeof params.key !== "string" || params.key.length === 0 || params.key.length > 40) {
          throw codedError("invalid_action", "press requires a key string");
        }
        const descriptor = keyDescriptor(params.key);
        const result = await withPageDebugger(params.tabId, async (target) => {
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...descriptor });
          const { text, ...keyUpDescriptor } = descriptor;
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...keyUpDescriptor });
          return { pressed: true, key: descriptor.key, target: prepared.target };
        });
        pageSnapshotsByTabId.delete(params.tabId);
        return { ...result, ref: params.ref, snapshotId: locator.snapshotId, needsSnapshot: true };
      }
      if (params.kind === "fill") {
        if (typeof params.value !== "string" || params.value.length > 100_000) {
          throw codedError("invalid_action", "fill requires a string value of at most 100000 characters");
        }
        const result = await execute(params.tabId, performPreparedDomAction, [marker, "fill", params.value]);
        pageSnapshotsByTabId.delete(params.tabId);
        return { ...result, ref: params.ref, snapshotId: locator.snapshotId, needsSnapshot: true };
      }
      const values = params.values ?? (params.value == null ? null : [params.value]);
      if (!Array.isArray(values) || values.length === 0 || values.length > 100 || values.some((value) => typeof value !== "string" || value.length > 1_000)) {
        throw codedError("invalid_action", "select requires value or values containing 1 to 100 strings");
      }
      const result = await execute(params.tabId, performPreparedDomAction, [marker, "select", values]);
      pageSnapshotsByTabId.delete(params.tabId);
      return { ...result, ref: params.ref, snapshotId: locator.snapshotId, needsSnapshot: true };
    } finally {
      if (prepared) {
        try {
          await execute(params.tabId, cleanupPreparedTarget, [marker]);
        } catch {
          // Cleanup is best-effort when a successful action navigates or replaces the target.
        }
      }
    }
  });
}

function integerParameter(value, name, { defaultValue, min, max }) {
  const parsed = value == null ? defaultValue : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw codedError("invalid_request", `${name} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function sanitizeNetworkUrl(value, urlMode = "origin_path") {
  try {
    const url = new URL(String(value));
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return `${url.protocol}`;
    url.username = "";
    url.password = "";
    if (urlMode !== "full") url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "[unparseable-url]";
  }
}

function networkDurationMs(startedAt, endedAt) {
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return undefined;
  return Number(((endedAt - startedAt) * 1_000).toFixed(3));
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

function networkEventFor(session, method, params, source) {
  const sourceKey = typeof source?.sessionId === "string" ? source.sessionId : "root";
  const requestKey = `${sourceKey}:${String(params?.requestId ?? "")}`;
  const known = session.requestMetadata.get(requestKey) || {};
  switch (method) {
    case "Network.requestWillBeSent": {
      const url = sanitizeNetworkUrl(params?.request?.url, session.urlMode);
      const resourceType = String(params?.type || "Other").toLowerCase();
      const method = String(params?.request?.method || "GET").slice(0, 32);
      const startedAt = Number.isFinite(params?.timestamp) ? params.timestamp : undefined;
      session.requestMetadata.set(requestKey, { url, resourceType, method, startedAt });
      return {
        kind: "request",
        requestId: publicRequestId(session, requestKey),
        url,
        method,
        resourceType,
        initiator: {
          type: String(params?.initiator?.type || "other").slice(0, 32),
          ...(params?.initiator?.url ? { url: sanitizeNetworkUrl(params.initiator.url, session.urlMode) } : {}),
        },
      };
    }
    case "Network.responseReceived": {
      const url = sanitizeNetworkUrl(params?.response?.url, session.urlMode);
      const resourceType = String(params?.type || known.resourceType || "Other").toLowerCase();
      const status = Number.isFinite(params?.response?.status) ? params.response.status : undefined;
      session.requestMetadata.set(requestKey, { ...known, url, resourceType, status });
      return {
        kind: "response",
        requestId: publicRequestId(session, requestKey),
        url,
        method: known.method,
        status,
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
        method: known.method,
        status: known.status,
        resourceType: known.resourceType || "other",
        durationMs: networkDurationMs(known.startedAt, params?.timestamp),
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
        method: known.method,
        status: known.status,
        resourceType: known.resourceType || "other",
        durationMs: networkDurationMs(known.startedAt, params?.timestamp),
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
      const url = sanitizeNetworkUrl(params?.url, session.urlMode);
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
  let rawSession = null;
  if (params.rawSessionId != null) {
    rawSession = requireRawSession(params.rawSessionId);
    if (rawSession.state !== "running") {
      throw codedError("raw_session_detached", `Raw CDP session is ${rawSession.state}`);
    }
    if (rawSession.tabId !== params.tabId) {
      throw codedError("raw_target_not_found", "rawSessionId is attached to a different tab");
    }
  }
  if (rawSessionByTabId.has(params.tabId) && !rawSession) {
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
  const urlMode = params.urlMode == null ? "origin_path" : params.urlMode;
  if (!["origin_path", "full"].includes(urlMode)) {
    throw codedError("invalid_request", "urlMode must be origin_path or full");
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
    urlMode,
    attachmentOwner: rawSession ? "raw" : "network",
    rawSessionId: rawSession?.id,
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
    if (!rawSession) {
      await chrome.debugger.attach({ tabId: params.tabId }, CDP_PROTOCOL_VERSION);
      attached = true;
    }
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
    urlMode,
    attachmentOwner: session.attachmentOwner,
    ...(session.rawSessionId ? { rawSessionId: session.rawSessionId } : {}),
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
    if (wasRunning && session.attachmentOwner === "network") {
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

function markNetworkSessionDetached(tabId) {
  const sessionId = networkSessionByTabId.get(tabId);
  const session = sessionId ? networkSessions.get(sessionId) : null;
  if (!session) return;
  session.state = "detached";
  networkSessionByTabId.delete(tabId);
  resolveNetworkWaiters(session);
}

function handleDebuggerEvent(source, method, params) {
  handleRawDebuggerEvent(source, method, params);
  if (!Number.isInteger(source?.tabId)) return;
  const sessionId = networkSessionByTabId.get(source.tabId);
  const session = sessionId ? networkSessions.get(sessionId) : null;
  if (!session || session.state !== "running") return;
  recordNetworkEvent(session, networkEventFor(session, method, params ?? {}, source));
}

function handleDebuggerDetach(source) {
  const handledRaw = handleRawDebuggerDetach(source);
  if (!Number.isInteger(source?.tabId)) return;
  if (!handledRaw) markNetworkSessionDetached(source.tabId);
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
    captureEvents: session.captureEvents,
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
  const captureEvents = params.captureEvents !== false;
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
    captureEvents,
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
    captureEvents,
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
    markNetworkSessionDetached(session.tabId);
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
  if (session.captureEvents) recordRawEvent(session, source, method, params ?? {});
  return true;
}

function handleRawDebuggerDetach(source) {
  const session = rawSessionForSource(source);
  if (!session) return false;
  if (typeof source?.sessionId === "string") {
    unregisterRawChildSession(session, source.sessionId);
    return true;
  }
  session.state = "detached";
  markNetworkSessionDetached(session.tabId);
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
      pageSnapshotsByTabId.delete(params.tabId);
      return publicTab(await chrome.tabs.update(params.tabId, { url: safeUrl(params.url) }));
    }
    case "page.snapshot":
      return snapshotTab(params.tabId, Math.min(params.maxChars || MAX_SNAPSHOT_CHARS, MAX_SNAPSHOT_CHARS));
    case "page.screenshot": {
      const tab = await requireTab(params.tabId);
      await activateTab(params.tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return { dataUrl, tabId: params.tabId };
    }
    case "page.click":
      return pageAction({ ...params, kind: "click" });
    case "page.fill":
      return pageAction({ ...params, kind: "fill" });
    case "page.act":
      return pageAction(params);
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
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "loading") pageSnapshotsByTabId.delete(tabId);
  emitBrowserEvent("tab.updated", {
    tabId,
    changeInfo: {
      status: changeInfo.status,
      title: changeInfo.title,
      url: changeInfo.url,
    },
    tab: publicTab(tab),
  });
});
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  createdTabIds.delete(tabId);
  pageSnapshotsByTabId.delete(tabId);
  pageActionChains.delete(tabId);
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
