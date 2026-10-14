import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// Chrome service workers have a global `crypto`; Node 18 does not.
globalThis.crypto ??= webcrypto;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const features = await import(pathToFileURL(path.join(root, "extension/features/index.js")));

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** A chrome.* double that records registrations and can fail chosen calls. */
function fakeChrome({ store = {}, tabs = [], failRules = false, failScripts = false } = {}) {
  const state = { rules: [], scripts: new Map(), reloaded: [], updated: [], store };
  return {
    state,
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      getManifest: () => ({ version: "0.0.0" }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
      },
    },
    declarativeNetRequest: {
      async updateDynamicRules({ removeRuleIds, addRules }) {
        if (failRules && addRules.length > 0) throw new Error("Rule rejected");
        state.rules = state.rules.filter((rule) => !removeRuleIds.includes(rule.id)).concat(addRules);
      },
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return [...state.scripts.values()].filter((script) => ids.includes(script.id)); },
      async unregisterContentScripts({ ids }) { for (const id of ids) state.scripts.delete(id); },
      async registerContentScripts(list) {
        if (failScripts && list.some((script) => script.id.endsWith("region-lock"))) throw new Error("Script rejected");
        for (const script of list) state.scripts.set(script.id, script);
      },
    },
    tabs: {
      async query() { return tabs; },
      async reload(tabId) { state.reloaded.push(tabId); },
      async update(tabId, properties) { state.updated.push([tabId, properties.url]); },
    },
  };
}

const scriptIds = (chrome) => [...chrome.state.scripts.keys()].sort();

test("both features start off and nothing is registered until the user turns one on", async () => {
  const chrome = fakeChrome();
  const state = await features.getFeatureState(chrome);
  assert.deepEqual(state.settings, {
    chatgptChecker: { enabled: false },
    regionLock: { enabled: false, profileId: "us-east" },
  });
  assert.deepEqual(state.errors, {});
  assert.deepEqual(state.profiles.map((profile) => profile.id), ["us-east", "us-central", "us-mountain", "us-pacific"]);

  await features.syncFeatures(chrome);
  assert.deepEqual(scriptIds(chrome), []);
  assert.deepEqual(chrome.state.rules, []);
});

test("enabling and disabling each feature is independent and persisted", async () => {
  const chrome = fakeChrome();
  const checker = await features.updateFeatures({ chatgptChecker: { enabled: true } }, chrome);
  assert.equal(checker.settings.chatgptChecker.enabled, true);
  assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker"]);
  assert.equal(chrome.state.rules.length, 0);

  const region = await features.updateFeatures({ regionLock: { enabled: true, profileId: "us-central" } }, chrome);
  assert.deepEqual(region.settings.regionLock, { enabled: true, profileId: "us-central" });
  assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker", "chrome-agent-bridge-region-lock"]);
  assert.equal(chrome.state.rules[0].action.requestHeaders[0].value, "en-US,en;q=0.9");
  assert.equal(chrome.state.scripts.get("chrome-agent-bridge-region-lock").js[0], "features/page/profiles/us-central.js");
  assert.equal(region.regionLock.timeZone, "America/Chicago");

  // Changing only the profile keeps the lock on and swaps the registration.
  await features.updateFeatures({ regionLock: { profileId: "us-pacific" } }, chrome);
  assert.equal(chrome.state.scripts.get("chrome-agent-bridge-region-lock").js[0], "features/page/profiles/us-pacific.js");
  assert.equal(chrome.state.rules.length, 1);

  await features.updateFeatures({ chatgptChecker: { enabled: false } }, chrome);
  assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-region-lock"]);
  await features.updateFeatures({ regionLock: { enabled: false } }, chrome);
  assert.deepEqual(scriptIds(chrome), []);
  assert.deepEqual(chrome.state.rules, []);
  assert.deepEqual((await features.getFeatureState(chrome)).settings, {
    chatgptChecker: { enabled: false },
    regionLock: { enabled: false, profileId: "us-pacific" },
  });
});

test("malformed settings never switch a feature on", async () => {
  const chrome = fakeChrome({ store: { featureSettings: { chatgptChecker: { enabled: "true" }, regionLock: { enabled: 1, profileId: {} } } } });
  assert.deepEqual((await features.getFeatureState(chrome)).settings, {
    chatgptChecker: { enabled: false },
    regionLock: { enabled: false, profileId: "us-east" },
  });
  const state = await features.updateFeatures({ chatgptChecker: "on", regionLock: { enabled: "yes", profileId: "mars" } }, chrome);
  assert.equal(state.settings.chatgptChecker.enabled, false);
  assert.deepEqual(state.settings.regionLock, { enabled: false, profileId: "us-east" });
  assert.deepEqual(scriptIds(chrome), []);
});

test("a feature Chrome rejects is rolled back and reported, without touching the other", async () => {
  const chrome = fakeChrome({ failRules: true });
  const state = await features.updateFeatures(
    { chatgptChecker: { enabled: true }, regionLock: { enabled: true } },
    chrome,
  );
  assert.equal(state.settings.chatgptChecker.enabled, true);
  assert.equal(state.settings.regionLock.enabled, false);
  assert.match(state.errors.regionLock, /Rule rejected/);
  assert.equal(state.errors.chatgptChecker, undefined);
  assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker"]);
  assert.deepEqual(chrome.state.rules, []);
  assert.deepEqual(chrome.state.store.featureSettings.regionLock, { enabled: false, profileId: "us-east" });
  assert.match((await features.getFeatureState(chrome)).errors.regionLock, /Rule rejected/);
});

test("starting the browser re-applies the stored settings and clears stale errors", async () => {
  const store = {
    featureSettings: { chatgptChecker: { enabled: true }, regionLock: { enabled: true, profileId: "us-mountain" } },
    featureErrors: { regionLock: "old failure" },
  };
  const chrome = fakeChrome({ store });
  const state = await features.syncFeatures(chrome);
  assert.deepEqual(state.errors, {});
  assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker", "chrome-agent-bridge-region-lock"]);
  assert.equal(chrome.state.scripts.get("chrome-agent-bridge-region-lock").js[0], "features/page/profiles/us-mountain.js");
  assert.deepEqual(store.featureErrors, {});

  const failing = fakeChrome({ store: { featureSettings: store.featureSettings }, failScripts: true });
  const failed = await features.syncFeatures(failing);
  assert.match(failed.errors.regionLock, /Script rejected/);
  assert.deepEqual(scriptIds(failing), ["chrome-agent-bridge-chatgpt-checker"]);
});

test("reloading ChatGPT tabs cleans the OpenAI region path only while the lock is on", async () => {
  const tabs = [
    { id: 1, url: "https://chatgpt.com/c/abc" },
    { id: 2, url: "https://openai.com/zh-Hans-CN/research/" },
    { id: 3, url: "https://platform.openai.com/docs" },
    { id: 4, url: "https://example.com/" },
    { id: 5, url: "https://www.openai.com/zh-Hans-CN/" },
  ];
  const off = fakeChrome({ tabs });
  assert.deepEqual(await features.reloadChatgptTabs(off), { reloaded: 4, cleaned: 0 });
  assert.deepEqual(off.state.reloaded, [1, 2, 3, 5]);

  const on = fakeChrome({ tabs, store: { featureSettings: { regionLock: { enabled: true } } } });
  assert.deepEqual(await features.reloadChatgptTabs(on), { reloaded: 3, cleaned: 1 });
  assert.deepEqual(on.state.updated, [[2, "https://openai.com/research/"]]);
  assert.deepEqual(on.state.reloaded, [1, 3, 5]);
});

test("popup messages route to the matching handler and unknown ones are rejected", async () => {
  const chrome = fakeChrome();
  assert.equal((await features.handleFeatureMessage({ type: "features.get" }, chrome)).settings.regionLock.enabled, false);
  const set = await features.handleFeatureMessage(
    { type: "features.set", settings: { regionLock: { enabled: true } } },
    chrome,
  );
  assert.equal(set.settings.regionLock.enabled, true);
  assert.deepEqual(await features.handleFeatureMessage({ type: "features.reload-tabs" }, chrome), { reloaded: 0, cleaned: 0 });
  await assert.rejects(features.handleFeatureMessage({ type: "features.nope" }, chrome), { code: "method_not_found" });
});

// --- through the real service worker -----------------------------------------

async function loadWorker(chromeDouble) {
  const nativeMessages = [];
  const nativeMessage = event();
  const port = { onMessage: nativeMessage, onDisconnect: event(), postMessage(message) { nativeMessages.push(message); } };
  const passive = () => event();
  chromeDouble.runtime.connectNative = () => port;
  chromeDouble.runtime.onInstalled = event();
  chromeDouble.runtime.onStartup = event();
  chromeDouble.action = { onClicked: passive() };
  chromeDouble.tabs = {
    ...chromeDouble.tabs,
    async get(tabId) { return { id: tabId, windowId: 1, active: true, status: "complete", url: "https://chatgpt.com/c/x" }; },
    onCreated: passive(), onUpdated: passive(), onRemoved: passive(), onActivated: passive(),
  };
  globalThis.chrome = chromeDouble;
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?features=${Math.random()}`);
  await settle();
  const ask = (message, sender = { id: chromeDouble.runtime.id }) => new Promise((resolve) => {
    const keepOpen = chromeDouble.runtime.onMessage.listener(message, sender, resolve);
    if (keepOpen !== true) resolve(undefined);
  });
  const request = async (method, params) => {
    const id = `req-${Math.random()}`;
    await nativeMessage.listener({ type: "request", id, method, params }, port);
    await settle();
    return nativeMessages.find((message) => message.type === "response" && message.id === id);
  };
  return { ask, request, chrome: chromeDouble };
}

test("the service worker serves the popup and the checker.status bridge method", async () => {
  const previous = globalThis.chrome;
  try {
    const chrome = fakeChrome();
    const worker = await loadWorker(chrome);

    const initial = await worker.ask({ type: "features.get" });
    assert.equal(initial.ok, true);
    assert.equal(initial.result.settings.chatgptChecker.enabled, false);

    // A message from another extension or page is ignored.
    assert.equal(await worker.ask({ type: "features.get" }, { id: "someone-else" }), undefined);

    const disabled = await worker.request("checker.status", { tabId: 1 });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.error.code, "checker_disabled");

    const enabled = await worker.ask({ type: "features.set", settings: { chatgptChecker: { enabled: true } } });
    assert.equal(enabled.ok, true);
    assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker"]);

    chrome.scripting.executeScript = async () => [{ result: null }];
    const status = await worker.request("checker.status", { tabId: 1 });
    assert.equal(status.ok, true);
    assert.equal(status.result.panel.present, false);
    assert.equal(status.result.tab.id, 1);

    // Browser start and extension update re-apply the stored settings.
    chrome.state.scripts.clear();
    await chrome.runtime.onStartup.listener();
    await settle();
    assert.deepEqual(scriptIds(chrome), ["chrome-agent-bridge-chatgpt-checker"]);
  } finally {
    globalThis.chrome = previous;
  }
});
