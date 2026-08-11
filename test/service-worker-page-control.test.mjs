import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.crypto ??= webcrypto;

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
}

function chromeHarness({ inspectResults = [] } = {}) {
  const nativeMessages = [];
  const debuggerCalls = [];
  const scriptCalls = [];
  const nativeMessage = event();
  const debuggerEvent = event();
  const debuggerDetach = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const passiveEvent = () => event();
  const chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.7.0" }),
      onInstalled: passiveEvent(),
      onStartup: passiveEvent(),
      onMessage: passiveEvent(),
    },
    action: { onClicked: passiveEvent() },
    windows: { update: async () => ({}) },
    tabs: {
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://example.com/menu" }),
      query: async () => [],
      onCreated: passiveEvent(),
      onUpdated: passiveEvent(),
      onRemoved: passiveEvent(),
      onActivated: passiveEvent(),
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        scriptCalls.push([func.name, args]);
        if (func.name === "snapshotPage") {
          return [{ result: {
            title: "Menu",
            url: "https://example.com/menu",
            text: "1 minute 15 minute",
            truncated: false,
            snapshot: '- combobox "1 minute" [ref=e1] [expanded=false]',
            elements: [{
              index: 0,
              ref: "e1",
              selector: "#period",
              tag: "button",
              role: "combobox",
              name: "1 minute",
              disabled: false,
              expanded: false,
              _locator: {
                selector: "#period",
                role: "combobox",
                name: "1 minute",
                nth: 0,
                id: "period",
                tag: "button",
              },
            }],
          } }];
        }
        if (func.name === "prepareActionTarget") {
          return [{ result: { marker: args[1], x: 125, y: 64, target: { role: "combobox", name: "1 minute", tag: "button" } } }];
        }
        if (func.name === "inspectPreparedTarget") return [{ result: inspectResults.shift() || { ok: true } }];
        if (func.name === "performPreparedDomAction") {
          return [{ result: args[1] === "fill"
            ? { filled: true, length: args[2].length }
            : { selected: true, values: args[2] } }];
        }
        if (func.name === "cleanupPreparedTarget") return [{ result: { cleaned: true } }];
        return [{ result: null }];
      },
    },
    debugger: {
      attach: async (target, version) => debuggerCalls.push(["attach", target, version]),
      detach: async (target) => debuggerCalls.push(["detach", target]),
      sendCommand: async (target, method, params) => {
        debuggerCalls.push(["command", target, method, params]);
        return {};
      },
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
    },
  };
  return { chrome, debuggerCalls, nativeMessage, nativeMessages, port, scriptCalls };
}

async function request(harness, id, method, params) {
  await harness.nativeMessage.listener({ type: "request", id, method, params }, harness.port);
  await flush();
  return harness.nativeMessages.find((message) => message.id === id);
}

async function loadHarness(options) {
  const harness = chromeHarness(options);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = harness.chrome;
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?page=${crypto.randomUUID()}`);
  return { harness, restore: () => { globalThis.chrome = previousChrome; } };
}

test("semantic snapshot refs drive one atomic CDP click and become stale afterward", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const snapshot = await request(harness, "snapshot", "page.snapshot", { tabId: 42, maxChars: 30_000 });
    assert.equal(snapshot.ok, true);
    assert.match(snapshot.result.snapshotId, /^snapshot_/);
    assert.equal(snapshot.result.refCount, 1);
    assert.equal(snapshot.result.elements[0].ref, "e1");
    assert.equal("_locator" in snapshot.result.elements[0], false);

    const clicked = await request(harness, "click", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.result.clicked, true);
    assert.equal(clicked.result.needsSnapshot, true);
    assert.deepEqual(
      harness.debuggerCalls.map((call) => call[0] === "command" ? [call[0], call[2], call[3].type] : call),
      [
        ["attach", { tabId: 42 }, "1.3"],
        ["command", "Input.dispatchMouseEvent", "mouseMoved"],
        ["command", "Input.dispatchMouseEvent", "mousePressed"],
        ["command", "Input.dispatchMouseEvent", "mouseReleased"],
        ["detach", { tabId: 42 }],
      ],
    );

    const stale = await request(harness, "stale", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(stale.ok, false);
    assert.equal(stale.error.code, "stale_ref");
  } finally {
    restore();
  }
});

test("atomic click re-resolves once when hover shifts the target", async () => {
  const { harness, restore } = await loadHarness({
    inspectResults: [{ ok: true }, { ok: false }, { ok: true }, { ok: true }],
  });
  try {
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const clicked = await request(harness, "click-retry", "page.act", { tabId: 42, kind: "click", ref: "e1" });
    assert.equal(clicked.ok, true);
    assert.equal(clicked.result.attempts, 2);
    assert.deepEqual(
      harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchMouseEvent").map((call) => call[3].type),
      ["mouseMoved", "mouseMoved", "mousePressed", "mouseReleased"],
    );
  } finally {
    restore();
  }
});

test("page actions reuse an existing Raw attachment for keyboard input", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const raw = await request(harness, "raw", "raw.attach", { tabId: 42, captureEvents: false });
    await request(harness, "snapshot", "page.snapshot", { tabId: 42 });
    const pressed = await request(harness, "press", "page.act", { tabId: 42, kind: "press", ref: "e1", key: "ArrowDown" });
    assert.equal(pressed.ok, true);
    assert.equal(pressed.result.pressed, true);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "attach").length, 1);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "detach").length, 0);
    assert.deepEqual(
      harness.debuggerCalls.filter((call) => call[2] === "Input.dispatchKeyEvent").map((call) => call[3].type),
      ["keyDown", "keyUp"],
    );

    await request(harness, "raw-detach", "raw.detach", { sessionId: raw.result.sessionId });
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "detach").length, 1);
  } finally {
    restore();
  }
});

test("fill and native select use the prepared semantic target without a debugger attachment", async () => {
  const { harness, restore } = await loadHarness();
  try {
    await request(harness, "snapshot-fill", "page.snapshot", { tabId: 42 });
    const filled = await request(harness, "fill", "page.act", { tabId: 42, kind: "fill", ref: "e1", value: "hello" });
    assert.equal(filled.ok, true);
    assert.equal(filled.result.length, 5);

    await request(harness, "snapshot-select", "page.snapshot", { tabId: 42 });
    const selected = await request(harness, "select", "page.act", { tabId: 42, kind: "select", ref: "e1", values: ["15 minute"] });
    assert.equal(selected.ok, true);
    assert.deepEqual(selected.result.values, ["15 minute"]);
    assert.equal(harness.debuggerCalls.length, 0);
  } finally {
    restore();
  }
});
