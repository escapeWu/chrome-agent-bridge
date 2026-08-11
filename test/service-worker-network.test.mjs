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

test("network monitor returns sanitized metadata and detaches cleanly", async () => {
  const nativeMessages = [];
  const debuggerCalls = [];
  const nativeMessage = event();
  const nativeDisconnect = event();
  const debuggerEvent = event();
  const debuggerDetach = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: nativeDisconnect,
    postMessage(message) { nativeMessages.push(message); },
  };
  const passiveEvent = () => event();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
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
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://example.com/chart" }),
      onCreated: passiveEvent(),
      onUpdated: passiveEvent(),
      onRemoved: passiveEvent(),
      onActivated: passiveEvent(),
    },
    scripting: { executeScript: async () => [{ result: null }] },
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

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?network=${Date.now()}`);

    await nativeMessage.listener({
      type: "request",
      id: "network-start",
      method: "network.start",
      params: { tabId: 42, maxEvents: 10, maxBytes: 65_536 },
    }, port);
    await flush();
    const started = nativeMessages.find((message) => message.id === "network-start");
    assert.equal(started.ok, true);
    assert.match(started.result.sessionId, /^net_/);
    assert.deepEqual(debuggerCalls[0], ["attach", { tabId: 42 }, "1.3"]);
    assert.equal(debuggerCalls[1][2], "Network.enable");

    debuggerEvent.listener(
      { tabId: 42 },
      "Network.requestWillBeSent",
      {
        requestId: "private-cdp-request-id",
        timestamp: 10,
        type: "Fetch",
        request: {
          method: "GET",
          url: "https://username:password@example.com/api/candles?token=secret#private",
          headers: {
            Authorization: "Bearer secret",
            Cookie: "session=secret",
          },
          postData: "secret request body",
        },
        initiator: {
          type: "script",
          url: "https://example.com/app.js?signature=secret",
        },
      },
    );
    debuggerEvent.listener(
      { tabId: 42 },
      "Network.responseReceived",
      {
        requestId: "private-cdp-request-id",
        timestamp: 10.1,
        type: "Fetch",
        response: {
          url: "https://example.com/api/candles?token=secret",
          status: 200,
          mimeType: "application/json",
          protocol: "h2",
          headers: { "Set-Cookie": "session=secret" },
          securityDetails: { issuer: "private" },
        },
      },
    );
    debuggerEvent.listener(
      { tabId: 42 },
      "Network.loadingFinished",
      {
        requestId: "private-cdp-request-id",
        timestamp: 10.25,
        encodedDataLength: 512,
      },
    );

    await nativeMessage.listener({
      type: "request",
      id: "network-poll",
      method: "network.poll",
      params: { sessionId: started.result.sessionId, afterCursor: 0, timeoutMs: 0 },
    }, port);
    await flush();
    const polled = nativeMessages.find((message) => message.id === "network-poll");
    assert.equal(polled.ok, true);
    assert.equal(polled.result.events.length, 3);
    assert.equal(polled.result.events[0].url, "https://example.com/api/candles");
    assert.equal(polled.result.events[0].requestId, "request-1");
    assert.equal(polled.result.events[1].requestId, "request-1");
    assert.deepEqual(
      {
        method: polled.result.events[2].method,
        status: polled.result.events[2].status,
        durationMs: polled.result.events[2].durationMs,
        encodedDataLength: polled.result.events[2].encodedDataLength,
      },
      { method: "GET", status: 200, durationMs: 250, encodedDataLength: 512 },
    );
    const serialized = JSON.stringify(polled.result);
    for (const forbidden of [
      "password",
      "token=secret",
      "Bearer secret",
      "session=secret",
      "secret request body",
      "private-cdp-request-id",
      "securityDetails",
    ]) {
      assert.equal(serialized.includes(forbidden), false, `leaked ${forbidden}`);
    }

    await nativeMessage.listener({
      type: "request",
      id: "network-stop",
      method: "network.stop",
      params: { sessionId: started.result.sessionId },
    }, port);
    await flush();
    const stopped = nativeMessages.find((message) => message.id === "network-stop");
    assert.equal(stopped.ok, true);
    assert.equal(stopped.result.state, "stopped");
    assert.ok(debuggerCalls.some((call) => call[0] === "command" && call[2] === "Network.disable"));
    assert.ok(debuggerCalls.some((call) => call[0] === "detach" && call[1].tabId === 42));
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("network monitor is isolated to its selected tab", async () => {
  const nativeMessages = [];
  const nativeMessage = event();
  const debuggerEvent = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const passiveEvent = () => event();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = {
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
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://example.com/" }),
      onCreated: passiveEvent(),
      onUpdated: passiveEvent(),
      onRemoved: passiveEvent(),
      onActivated: passiveEvent(),
    },
    scripting: { executeScript: async () => [{ result: null }] },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: debuggerEvent,
      onDetach: passiveEvent(),
    },
  };

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?isolation=${Date.now()}`);
    await nativeMessage.listener({
      type: "request",
      id: "start-isolated",
      method: "network.start",
      params: { tabId: 42 },
    }, port);
    await flush();
    const sessionId = nativeMessages.find((message) => message.id === "start-isolated").result.sessionId;

    debuggerEvent.listener(
      { tabId: 99 },
      "Network.requestWillBeSent",
      { requestId: "other", type: "XHR", request: { method: "GET", url: "https://other.example/" } },
    );
    await nativeMessage.listener({
      type: "request",
      id: "poll-isolated",
      method: "network.poll",
      params: { sessionId, afterCursor: 0, timeoutMs: 0 },
    }, port);
    await flush();
    const polled = nativeMessages.find((message) => message.id === "poll-isolated");
    assert.deepEqual(polled.result.events, []);
  } finally {
    globalThis.chrome = previousChrome;
  }
});
