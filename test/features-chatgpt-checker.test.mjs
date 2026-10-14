import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const checker = await import(pathToFileURL(path.join(extension, "features/chatgpt-checker.js")));
const features = await import(pathToFileURL(path.join(extension, "features/index.js")));
const {
  applyChatgptChecker,
  buildContentScript,
  CHECKER_FILES,
  CHECKER_SCRIPT_ID,
  collectCheckerPanel,
  interpretPanel,
  isCheckerUrl,
  normalizeChatgptChecker,
} = checker;

const userscript = fs.readFileSync(path.join(extension, "vendor/chatgpt-checker-next.user.js"), "utf8");
const header = userscript.slice(0, userscript.indexOf("==/UserScript=="));

test("the checker is off by default and mounts only on chatgpt.com, top frame, main world", () => {
  assert.deepEqual(normalizeChatgptChecker(undefined), { enabled: false });
  assert.deepEqual(normalizeChatgptChecker({ enabled: "true" }), { enabled: false });
  assert.deepEqual(normalizeChatgptChecker({ enabled: true }), { enabled: true });

  const script = buildContentScript();
  assert.equal(script.id, CHECKER_SCRIPT_ID);
  assert.deepEqual(script.matches, ["https://chatgpt.com/*"]);
  assert.deepEqual(script.js, ["features/page/gm-shim.js", "vendor/chatgpt-checker-next.user.js"]);
  assert.equal(script.world, "MAIN");
  assert.equal(script.runAt, "document_start");
  assert.equal(script.allFrames, false);
  for (const file of CHECKER_FILES) assert.ok(fs.existsSync(path.join(extension, file)), file);

  assert.equal(isCheckerUrl("https://chatgpt.com/c/abc"), true);
  assert.equal(isCheckerUrl("https://www.chatgpt.com/"), false);
  assert.equal(isCheckerUrl("https://chatgpt.com.evil.example/"), false);
  assert.equal(isCheckerUrl("http://chatgpt.com/"), false);
});

test("applying the checker registers or removes exactly one script", async () => {
  const calls = [];
  let registered = [];
  const chrome = {
    scripting: {
      async getRegisteredContentScripts() { return registered; },
      async unregisterContentScripts({ ids }) { calls.push(["unregister", ids]); registered = []; },
      async registerContentScripts(list) { calls.push(["register", list.map((script) => script.id)]); registered = list; },
    },
  };
  await applyChatgptChecker({ enabled: true }, chrome);
  await applyChatgptChecker({ enabled: true }, chrome);
  await applyChatgptChecker({ enabled: false }, chrome);
  await applyChatgptChecker({ enabled: false }, chrome);
  assert.deepEqual(calls, [
    ["register", [CHECKER_SCRIPT_ID]],
    ["unregister", [CHECKER_SCRIPT_ID]],
    ["register", [CHECKER_SCRIPT_ID]],
    ["unregister", [CHECKER_SCRIPT_ID]],
  ]);
});

test("the vendored userscript still fits the shim, ships with its license, and makes no requests of its own", () => {
  const version = /@version\s+(\S+)/.exec(header)[1];
  const shim = fs.readFileSync(path.join(extension, "features/page/gm-shim.js"), "utf8");
  assert.equal(/GM_INFO_VERSION = "([^"]+)"/.exec(shim)[1], version, "update GM_INFO_VERSION with the vendored script");

  // The shim provides exactly these; a new @grant means the shim must grow first.
  const grants = [...header.matchAll(/@grant\s+(\S+)/g)].map((match) => match[1]).sort();
  assert.deepEqual(grants, ["GM_addElement", "unsafeWindow"]);
  assert.match(header, /@match\s+\*:\/\/chatgpt\.com\/\*/);
  assert.match(header, /@noframes/);
  assert.match(header, /@run-at\s+document-start/);
  assert.match(header, /@license\s+AGPLv3/);

  const license = fs.readFileSync(path.join(extension, "vendor/CHATGPT-CHECKER-NEXT-LICENSE.txt"), "utf8");
  assert.match(license, /GNU AFFERO GENERAL PUBLIC LICENSE/);
  // The script makes no requests of its own: it only wraps the page's fetch.
  assert.equal(/GM_xmlhttpRequest|sendBeacon|XMLHttpRequest|new WebSocket|importScripts/.test(userscript), false);
  assert.equal(/(?<![A-Za-z.])fetch\(/.test(userscript), false);
});

test("the shim gives the userscript its manager globals", () => {
  const appended = [];
  const document = {
    head: null,
    documentElement: { appendChild(element) { appended.push(element); } },
    createElement(tag) {
      const attributes = {};
      return { tag, attributes, setAttribute(name, value) { attributes[name] = value; } };
    },
  };
  const sandbox = { document, MutationObserver: class { observe() {} disconnect() {} } };
  const context = vm.createContext(sandbox);
  const evaluate = (code) => vm.runInContext(code, context);
  vm.runInContext(fs.readFileSync(path.join(extension, "features/page/gm-shim.js"), "utf8"), context);

  assert.equal(evaluate("unsafeWindow === globalThis"), true);
  assert.equal(evaluate('Object.keys(globalThis).some((key) => /^(unsafeWindow|GM_)/.test(key))'), false, "shim globals stay non-enumerable");
  assert.equal(evaluate("GM_info.script.version"), /@version\s+(\S+)/.exec(header)[1]);

  const style = evaluate('GM_addElement("style", { media: "not all", textContent: "a{}" })');
  assert.equal(style.tag, "style");
  assert.equal(style.attributes.media, "not all");
  assert.equal(style.textContent, "a{}");
  assert.deepEqual(appended, [style]);
});

// --- panel reading ---------------------------------------------------------

function fakeDocument({ elements, windows = [], links = [], mode = "chatgpt", text = "panel text" }) {
  class HTMLInputElement {}
  class HTMLSelectElement {}
  const nodes = elements.map(({ id, text: content = "", display = "block", checked, select }) => {
    let node;
    if (checked !== undefined) {
      node = Object.assign(new HTMLInputElement(), { type: "checkbox", checked });
    } else if (select) {
      node = Object.assign(new HTMLSelectElement(), {
        value: select.value,
        options: select.options.map(([value, label, extra = {}]) => ({ value, textContent: label, disabled: false, hidden: false, ...extra })),
      });
    } else {
      node = {};
    }
    return Object.assign(node, { id, textContent: content, display });
  });
  const row = (entry) => ({
    querySelector(selector) {
      const key = { ".codex-window-label": "label", ".codex-window-usage": "used", ".codex-window-reset-time": "resetTime" }[selector];
      return { textContent: entry[key] };
    },
  });
  const box = {
    dataset: { mode },
    innerText: text,
    querySelectorAll(selector) {
      if (selector === "[id]") return nodes;
      if (selector === "#codex-windows-container > div") return windows.map(row);
      if (selector === "a") return links.map((textContent) => ({ textContent }));
      throw new Error(`unexpected selector ${selector}`);
    },
  };
  return {
    document: { getElementById: (id) => (id === "checker-next-displayBox" ? box : null) },
    getComputedStyle: (node) => ({ display: node.display }),
    HTMLInputElement,
    HTMLSelectElement,
  };
}

function withGlobals(globals, run) {
  const saved = Object.fromEntries(Object.keys(globals).map((key) => [key, globalThis[key]]));
  Object.assign(globalThis, globals);
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  }
}

const populatedPanel = {
  links: ["ChatGPT Checker Next", "v5.2.2"],
  text: "ChatGPT PoW难度：07a120(优秀)",
  windows: [
    { label: "5 小时", used: "12%", resetTime: "2 小时 3 分后" },
    { label: "每周", used: "...", resetTime: "..." },
  ],
  elements: [
    { id: "difficulty", text: "07a120" },
    { id: "difficulty-level", text: "(优秀)" },
    { id: "persona", text: "chatgpt-paid" },
    { id: "user-region", text: "US / California / USD" },
    { id: "locale-info", text: "America/New_York / en-US" },
    { id: "chatgpt-runtime-origin", select: { value: "chat", options: [["chat", "Chat"], ["work", "Work"], ["dot", "Dot", { hidden: true }]] } },
    {
      id: "chatgpt-runtime-model",
      select: {
        value: "gpt-5",
        options: [["", "读取中…", { disabled: true }], ["gpt-5", "GPT-5"], ["gpt-5-mini", "GPT-5 mini"], ["__checker_next_custom__", "自定义…"]],
      },
    },
    { id: "chatgpt-runtime-thinking", select: { value: "", options: [["", "读取中…", { disabled: true }], ["__checker_next_custom__", "自定义…"]] } },
    { id: "chatgpt-runtime-error", text: "", display: "none" },
    { id: "deep-research-section" },
    { id: "deep-research-usage", text: "7次" },
    { id: "deep-research-reset-time", text: "2026/11/13 08:00" },
    { id: "image-gen-section", display: "none" },
    { id: "image-gen-usage", text: "..." },
    { id: "image-gen-reset-time", text: "..." },
    { id: "memory-section" },
    { id: "memory-usage", text: "1200/6000" },
    { id: "codex-section" },
    { id: "codex-credits-container", display: "none" },
    { id: "codex-credits-value", text: "..." },
    { id: "codex-reset-credits-container" },
    { id: "codex-reset-credits-count", text: "2" },
    { id: "chatgpt-injection-status", text: "已启用" },
    { id: "chatgpt-module-injection-toggle", checked: true },
    { id: "chatgpt-copy-button-toggle", checked: false },
  ],
};

test("a populated panel is read back as structured status", () => {
  const raw = withGlobals(fakeDocument(populatedPanel), collectCheckerPanel);
  assert.equal(raw.mode, "chatgpt");
  assert.equal(raw.version, "5.2.2");

  const panel = interpretPanel(raw);
  assert.equal(panel.present, true);
  assert.equal(panel.version, "5.2.2");
  assert.deepEqual(panel.pow, { difficulty: "07a120", level: "优秀", assessment: "excellent" });
  assert.equal(panel.persona, "chatgpt-paid");
  assert.equal(panel.userRegion, "US / California / USD");
  assert.equal(panel.localeInfo, "America/New_York / en-US");
  assert.deepEqual(panel.model.mode, {
    value: "chat",
    label: "Chat",
    options: [{ value: "chat", label: "Chat" }, { value: "work", label: "Work" }],
  });
  assert.deepEqual(panel.model.model, {
    value: "gpt-5",
    label: "GPT-5",
    options: [{ value: "gpt-5", label: "GPT-5" }, { value: "gpt-5-mini", label: "GPT-5 mini" }],
  });
  assert.deepEqual(panel.model.thinking, { value: null, label: null, options: [] });
  assert.equal(panel.model.error, null);
  assert.deepEqual(panel.limits.find((limit) => limit.id === "deep-research"), {
    id: "deep-research", label: "Deep research", visible: true, remaining: "7次", resetTime: "2026/11/13 08:00",
  });
  assert.deepEqual(panel.limits.find((limit) => limit.id === "image-gen"), {
    id: "image-gen", label: "Image generation", visible: false, remaining: null, resetTime: null,
  });
  assert.deepEqual(panel.memory, { used: 1200, max: 6000 });
  assert.deepEqual(panel.codex, {
    windows: [
      { label: "5 小时", used: "12%", resetTime: "2 小时 3 分后" },
      { label: "每周", used: null, resetTime: null },
    ],
    credits: null,
    resetCredits: "2",
  });
  assert.equal(panel.moduleInjection, "已启用");
  assert.deepEqual(panel.toggles, { "chatgpt-module-injection": true, "chatgpt-copy-button": false });
  assert.equal(panel.text, "ChatGPT PoW难度：07a120(优秀)");
});

test("a panel that has not received any data yet reads as nulls, and each verdict maps", () => {
  const fresh = interpretPanel({
    mode: "chatgpt",
    version: null,
    text: "",
    windows: [],
    elements: {
      difficulty: { text: "..." },
      "difficulty-level": { text: "" },
      persona: { text: "..." },
      "memory-section": { text: "", hidden: true },
      "memory-usage": { text: "..." },
      "codex-section": { text: "", hidden: true },
    },
  });
  assert.deepEqual(fresh.pow, { difficulty: null, level: null, assessment: null });
  assert.equal(fresh.persona, null);
  assert.equal(fresh.memory, null);
  assert.equal(fresh.codex, null);
  assert.equal(fresh.model.model, null);
  assert.deepEqual(fresh.toggles, {});

  const verdict = (level) => interpretPanel({ elements: { "difficulty-level": { text: level } } }).pow.assessment;
  assert.deepEqual(["(风险)", "(中等)", "(良好)", "(优秀)", "(未知)"].map(verdict), ["risk", "medium", "good", "excellent", null]);
});

test("every panel id and class the reader depends on still exists in the vendored script", () => {
  const read = new Set();
  const elements = new Proxy({}, { get: (_, id) => { read.add(String(id)); return undefined; } });
  interpretPanel({ elements, windows: [] });
  assert.ok(read.size > 20);
  const templateIds = new Set([...userscript.matchAll(/\bid="([^"$]+)"/g)].map((match) => match[1]));
  assert.ok(templateIds.size > 50, "the template id pattern stopped matching");
  assert.deepEqual([...read].filter((id) => !templateIds.has(id)), []);

  for (const name of [
    "checker-next-displayBox",
    "codex-windows-container",
    "codex-window-label",
    "codex-window-usage",
    "codex-window-reset-time",
    "checker-next-copy-conversation-button",
  ]) {
    assert.ok(userscript.includes(name), `${name} disappeared from the vendored script`);
  }
  assert.match(userscript, /displayBox\.dataset\.mode = /);
  assert.match(userscript, /-toggle`?"?\)/);
});

// --- status tool -------------------------------------------------------------

function statusApi({ settings, tabs = {}, panel, scriptError }) {
  const scriptCalls = [];
  const store = settings === undefined ? {} : { featureSettings: settings };
  return {
    scriptCalls,
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
      },
    },
    tabs: {
      async get(tabId) {
        if (!(tabId in tabs)) throw new Error(`No tab with id: ${tabId}`);
        return tabs[tabId];
      },
    },
    scripting: {
      async executeScript(options) {
        scriptCalls.push(options);
        if (scriptError) throw new Error(scriptError);
        return [{ result: panel }];
      },
    },
  };
}

const enabled = { chatgptChecker: { enabled: true }, regionLock: { enabled: true, profileId: "us-pacific" } };
const chatTab = { id: 5, windowId: 2, active: true, status: "complete", url: "https://chatgpt.com/c/secret-conversation", title: "Private chat title" };

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
}

test("the status call refuses until the user has enabled the checker", async () => {
  const api = statusApi({ tabs: { 5: chatTab } });
  const error = await failure(features.chatgptCheckerStatus({ tabId: 5 }, api));
  assert.equal(error.code, "checker_disabled");
  assert.match(error.message, /popup/);
  assert.equal(api.scriptCalls.length, 0);
});

test("the status call validates the tab before reading anything", async () => {
  const api = statusApi({ settings: enabled, tabs: { 5: chatTab, 6: { id: 6, url: "https://example.com/" } } });
  assert.equal((await failure(features.chatgptCheckerStatus({}, api))).code, "invalid_tab_id");
  assert.equal((await failure(features.chatgptCheckerStatus({ tabId: -1 }, api))).code, "invalid_tab_id");
  assert.equal((await failure(features.chatgptCheckerStatus({ tabId: 99 }, api))).code, "tab_not_found");
  assert.equal((await failure(features.chatgptCheckerStatus({ tabId: 6 }, api))).code, "not_chatgpt_tab");
  assert.equal(api.scriptCalls.length, 0);
});

test("the status call returns the panel and region lock without the tab's URL or title", async () => {
  const raw = withGlobals(fakeDocument(populatedPanel), collectCheckerPanel);
  const api = statusApi({ settings: enabled, tabs: { 5: chatTab }, panel: raw });
  const result = await features.chatgptCheckerStatus({ tabId: 5 }, api);

  assert.deepEqual(api.scriptCalls[0].target, { tabId: 5 });
  assert.equal(api.scriptCalls[0].func, collectCheckerPanel);
  assert.deepEqual(result.tab, { id: 5, windowId: 2, active: true, status: "complete" });
  assert.equal(result.panel.pow.assessment, "excellent");
  assert.deepEqual(result.regionLock, {
    enabled: true,
    profileId: "us-pacific",
    label: "US Pacific",
    timeZone: "America/Los_Angeles",
    locale: "en-US",
    acceptLanguage: "en-US,en;q=0.9",
  });
  assert.equal(JSON.stringify(result).includes("secret-conversation"), false);
  assert.equal(JSON.stringify(result).includes("Private chat title"), false);
});

test("a tab without the panel reports that, and an unreadable tab reports why", async () => {
  const missing = await features.chatgptCheckerStatus(
    { tabId: 5 },
    statusApi({ settings: enabled, tabs: { 5: { ...chatTab, status: "loading" } }, panel: null }),
  );
  assert.equal(missing.panel.present, false);
  assert.equal(missing.tab.status, "loading");
  assert.match(missing.panel.hint, /reload the tab/);

  const error = await failure(features.chatgptCheckerStatus(
    { tabId: 5 },
    statusApi({ settings: enabled, tabs: { 5: chatTab }, scriptError: "Cannot access contents of the page" }),
  ));
  assert.equal(error.code, "checker_unreadable");
  assert.match(error.message, /Cannot access/);
});
