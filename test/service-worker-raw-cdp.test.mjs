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

function chromeHarness() {
  const nativeMessages = [];
  const debuggerCalls = [];
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
      get: async (tabId) => ({ id: tabId, windowId: 7, url: "https://example.com/" }),
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
        if (method === "Network.getAllCookies") {
          return { cookies: [{ name: "session", value: "raw-secret-cookie" }] };
        }
        if (method === "Target.attachToTarget") return { sessionId: "child-from-command" };
        return { echoedMethod: method, echoedParams: params };
      },
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
    },
  };
  return { chrome, debuggerCalls, debuggerDetach, debuggerEvent, nativeMessage, nativeMessages, port };
}

async function request(harness, id, method, params) {
  await harness.nativeMessage.listener({ type: "request", id, method, params }, harness.port);
  await flush();
  return harness.nativeMessages.find((message) => message.id === id);
}

test("Raw CDP relays arbitrary commands, sensitive results, and original events", async () => {
  const harness = chromeHarness();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = harness.chrome;

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?raw=${Date.now()}`);
    const attached = await request(harness, "raw-attach", "raw.attach", {
      tabId: 42,
      maxEvents: 20,
      maxBytes: 200_000,
    });
    assert.equal(attached.ok, true);
    assert.match(attached.result.sessionId, /^raw_/);
    assert.deepEqual(harness.debuggerCalls[0], ["attach", { tabId: 42 }, "1.3"]);

    const cookieResult = await request(harness, "raw-send-cookie", "raw.send", {
      sessionId: attached.result.sessionId,
      method: "Network.getAllCookies",
      params: {},
    });
    assert.equal(cookieResult.ok, true);
    assert.equal(cookieResult.result.result.cookies[0].value, "raw-secret-cookie");

    harness.debuggerEvent.listener(
      { tabId: 99 },
      "Unrelated.event",
      { secret: "other-tab-secret" },
    );
    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Network.requestWillBeSentExtraInfo",
      {
        headers: {
          Authorization: "Bearer raw-authorization-secret",
          Cookie: "session=raw-cookie-secret",
        },
        associatedCookies: [{ cookie: { name: "session", value: "raw-event-cookie" } }],
      },
    );
    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Target.attachedToTarget",
      { sessionId: "child-from-event", targetInfo: { targetId: "worker-1", type: "worker" } },
    );
    harness.debuggerEvent.listener(
      { sessionId: "child-from-event" },
      "Runtime.consoleAPICalled",
      { args: [{ type: "string", value: "raw-child-secret" }] },
    );

    const events = await request(harness, "raw-events", "raw.poll", {
      sessionId: attached.result.sessionId,
      afterCursor: 0,
      timeoutMs: 0,
    });
    assert.equal(events.ok, true);
    assert.equal(events.result.events.length, 3);
    const serializedEvents = JSON.stringify(events.result.events);
    for (const expected of [
      "Bearer raw-authorization-secret",
      "session=raw-cookie-secret",
      "raw-event-cookie",
      "raw-child-secret",
      "Network.requestWillBeSentExtraInfo",
    ]) {
      assert.equal(serializedEvents.includes(expected), true, `missing raw value ${expected}`);
    }
    assert.equal(serializedEvents.includes("other-tab-secret"), false);

    const childCommand = await request(harness, "raw-child-command", "raw.send", {
      sessionId: attached.result.sessionId,
      targetSessionId: "child-from-event",
      method: "Runtime.evaluate",
      params: { expression: "document.cookie" },
    });
    assert.equal(childCommand.ok, true);
    assert.ok(harness.debuggerCalls.some((call) =>
      call[0] === "command" &&
      call[1].sessionId === "child-from-event" &&
      call[2] === "Runtime.evaluate" &&
      call[3].expression === "document.cookie"
    ));

    const conflict = await request(harness, "network-conflict", "network.start", { tabId: 42 });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error.code, "debugger_target_busy");

    const detached = await request(harness, "raw-detach", "raw.detach", {
      sessionId: attached.result.sessionId,
    });
    assert.equal(detached.ok, true);
    assert.equal(detached.result.state, "stopped");
    assert.ok(harness.debuggerCalls.some((call) => call[0] === "detach" && call[1].tabId === 42));
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("Raw CDP event buffers are bounded and report truncation", async () => {
  const harness = chromeHarness();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = harness.chrome;

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?raw-bounds=${Date.now()}`);
    const attached = await request(harness, "raw-attach-bounds", "raw.attach", {
      tabId: 7,
      maxEvents: 1,
      maxBytes: 65_536,
    });
    harness.debuggerEvent.listener({ tabId: 7 }, "Test.first", { sequence: 1 });
    harness.debuggerEvent.listener({ tabId: 7 }, "Test.second", { sequence: 2 });

    const events = await request(harness, "raw-poll-bounds", "raw.poll", {
      sessionId: attached.result.sessionId,
      afterCursor: 0,
      timeoutMs: 0,
    });
    assert.equal(events.ok, true);
    assert.equal(events.result.events.length, 1);
    assert.equal(events.result.events[0].method, "Test.second");
    assert.equal(events.result.dropped, 1);
    assert.equal(events.result.truncated, true);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("Raw CDP commands share one attachment with a sanitized network projection", async () => {
  const harness = chromeHarness();
  const previousChrome = globalThis.chrome;
  globalThis.chrome = harness.chrome;

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?raw-network=${Date.now()}`);
    const attached = await request(harness, "raw-attach-projected", "raw.attach", {
      tabId: 42,
      captureEvents: false,
    });
    assert.equal(attached.ok, true);
    assert.equal(attached.result.captureEvents, false);

    const started = await request(harness, "network-start-projected", "network.start", {
      tabId: 42,
      rawSessionId: attached.result.sessionId,
      urlMode: "full",
      resourceTypes: ["fetch"],
    });
    assert.equal(started.ok, true);
    assert.equal(started.result.attachmentOwner, "raw");
    assert.equal(started.result.rawSessionId, attached.result.sessionId);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "attach").length, 1);

    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Network.requestWillBeSent",
      {
        requestId: "private-projected-request-id",
        timestamp: 20,
        type: "Fetch",
        request: {
          method: "POST",
          url: "https://username:password@example.com/api?token=query-secret#fragment-secret",
          headers: { Authorization: "Bearer header-secret", Cookie: "cookie-secret" },
          postData: "private-body",
        },
        initiator: { type: "script" },
      },
    );
    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Network.requestWillBeSentExtraInfo",
      {
        requestId: "private-projected-request-id",
        headers: { Authorization: "Bearer extra-header-secret", Cookie: "extra-cookie-secret" },
      },
    );
    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Network.responseReceived",
      {
        requestId: "private-projected-request-id",
        timestamp: 20.05,
        type: "Fetch",
        response: {
          url: "https://example.com/api?token=query-secret#response-fragment",
          status: 204,
          mimeType: "application/json",
          protocol: "h2",
          headers: { "Set-Cookie": "response-cookie-secret" },
        },
      },
    );
    harness.debuggerEvent.listener(
      { tabId: 42 },
      "Network.loadingFinished",
      { requestId: "private-projected-request-id", timestamp: 20.2, encodedDataLength: 64 },
    );

    const projected = await request(harness, "network-poll-projected", "network.poll", {
      sessionId: started.result.sessionId,
      afterCursor: 0,
      timeoutMs: 0,
    });
    assert.equal(projected.ok, true);
    assert.equal(projected.result.events.length, 3);
    assert.equal(projected.result.events[0].url, "https://example.com/api?token=query-secret");
    assert.deepEqual(
      {
        method: projected.result.events[2].method,
        status: projected.result.events[2].status,
        durationMs: projected.result.events[2].durationMs,
      },
      { method: "POST", status: 204, durationMs: 200 },
    );
    const projectedJson = JSON.stringify(projected.result);
    for (const forbidden of [
      "password",
      "fragment-secret",
      "header-secret",
      "cookie-secret",
      "private-body",
      "private-projected-request-id",
    ]) {
      assert.equal(projectedJson.includes(forbidden), false, `leaked projected value ${forbidden}`);
    }

    const rawEvents = await request(harness, "raw-events-disabled", "raw.poll", {
      sessionId: attached.result.sessionId,
      afterCursor: 0,
      timeoutMs: 0,
    });
    assert.equal(rawEvents.ok, true);
    assert.equal(rawEvents.result.captureEvents, false);
    assert.deepEqual(rawEvents.result.events, []);

    const detachCountBeforeStop = harness.debuggerCalls.filter((call) => call[0] === "detach").length;
    const stopped = await request(harness, "network-stop-projected", "network.stop", {
      sessionId: started.result.sessionId,
    });
    assert.equal(stopped.ok, true);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "detach").length, detachCountBeforeStop);
    assert.equal(harness.debuggerCalls.some((call) => call[0] === "command" && call[2] === "Network.disable"), false);

    const restarted = await request(harness, "network-restart-projected", "network.start", {
      tabId: 42,
      rawSessionId: attached.result.sessionId,
    });
    const detached = await request(harness, "raw-detach-projected", "raw.detach", {
      sessionId: attached.result.sessionId,
    });
    assert.equal(detached.ok, true);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "detach").length, 1);

    const afterDetach = await request(harness, "network-poll-after-raw-detach", "network.poll", {
      sessionId: restarted.result.sessionId,
      afterCursor: 0,
      timeoutMs: 0,
    });
    assert.equal(afterDetach.result.state, "detached");
  } finally {
    globalThis.chrome = previousChrome;
  }
});
