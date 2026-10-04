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
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/** A fake Chrome whose attach and commands can be held open by a test. */
function chromeHarness() {
  const nativeMessages = [];
  const debuggerCalls = [];
  const gates = { attach: null, command: null };
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
      getManifest: () => ({ version: "0.9.1" }),
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
      attach: async (target, version) => {
        debuggerCalls.push(["attach", target, version]);
        if (gates.attach) await gates.attach;
      },
      detach: async (target) => debuggerCalls.push(["detach", target]),
      sendCommand: async (target, method, params) => {
        debuggerCalls.push(["command", target, method, params]);
        if (method === "Slow.command" && gates.command) await gates.command;
        return {};
      },
      onEvent: debuggerEvent,
      onDetach: debuggerDetach,
    },
  };
  return { chrome, debuggerCalls, debuggerDetach, gates, nativeMessage, nativeMessages, port };
}

function send(harness, id, method, params) {
  return harness.nativeMessage.listener({ type: "request", id, method, params }, harness.port);
}

async function request(harness, id, method, params) {
  await send(harness, id, method, params);
  await flush();
  return harness.nativeMessages.find((message) => message.id === id);
}

function response(harness, id) {
  return harness.nativeMessages.find((message) => message.id === id);
}

const count = (harness, kind) => harness.debuggerCalls.filter((call) => call[0] === kind).length;

async function loadHarness() {
  const harness = chromeHarness();
  const previousChrome = globalThis.chrome;
  const realNow = Date.now;
  let now = realNow();
  globalThis.chrome = harness.chrome;
  Date.now = () => now;
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?lease=${crypto.randomUUID()}`);
  return {
    harness,
    advance(ms) { now += ms; },
    restore() {
      globalThis.chrome = previousChrome;
      Date.now = realNow;
    },
  };
}

test("an unreleased session blocks with details, then is taken over after its lease expires", async () => {
  const { harness, advance, restore } = await loadHarness();
  try {
    const first = await request(harness, "a-attach", "raw.attach", { tabId: 42, leaseTtlMs: 30_000, ownerLabel: "task-a" });
    assert.equal(first.ok, true);
    assert.equal(first.result.lease.leaseTtlMs, 30_000);
    assert.equal(first.result.lease.ownerLabel, "task-a");

    advance(10_000);
    const busy = await request(harness, "b-busy", "raw.attach", { tabId: 42 });
    assert.equal(busy.ok, false);
    assert.equal(busy.error.code, "debugger_target_busy");
    assert.equal(busy.error.details.tabId, 42);
    assert.equal(busy.error.details.occupant.sessionId, first.result.sessionId);
    assert.equal(busy.error.details.occupant.kind, "raw");
    assert.equal(busy.error.details.occupant.expired, false);
    assert.equal(busy.error.details.retryAfterMs, 20_000);
    assert.equal(count(harness, "attach"), 1);

    advance(20_000);
    const second = await request(harness, "b-attach", "raw.attach", { tabId: 42 });
    assert.equal(second.ok, true);
    assert.equal(second.result.reclaimed.sessionId, first.result.sessionId);
    assert.deepEqual(harness.debuggerCalls.map((call) => call[0]), ["attach", "detach", "attach"]);
    assert.equal(second.result.lease.leaseTtlMs, 5 * 60_000);

    // The old ID is revoked for good: it cannot command, renew, or tear down the new owner.
    const oldSend = await request(harness, "a-send", "raw.send", { sessionId: first.result.sessionId, method: "Page.enable" });
    assert.equal(oldSend.error.code, "raw_session_detached");
    const oldRenew = await request(harness, "a-renew", "debugger.renew", { sessionId: first.result.sessionId });
    assert.equal(oldRenew.error.code, "debugger_session_ended");
    const projection = await request(harness, "b-net", "network.start", { tabId: 42, rawSessionId: second.result.sessionId });
    assert.equal(projection.ok, true);
    const oldDetach = await request(harness, "a-detach", "raw.detach", { sessionId: first.result.sessionId });
    assert.equal(oldDetach.result.state, "reclaimed");
    assert.equal(count(harness, "detach"), 1);
    const listed = await request(harness, "list", "debugger.sessions", { tabId: 42 });
    assert.equal(listed.result.sessions.length, 1);
    assert.equal(listed.result.sessions[0].sessionId, second.result.sessionId);
    assert.equal(listed.result.sessions[0].projections[0].sessionId, projection.result.sessionId);
  } finally {
    restore();
  }
});

test("valid activity, renew, and waiting long polls keep a lease; invalid calls do not", async () => {
  const { harness, advance, restore } = await loadHarness();
  try {
    const owner = await request(harness, "attach", "raw.attach", { tabId: 5, leaseTtlMs: 60_000 });
    advance(50_000);
    await request(harness, "send", "raw.send", { sessionId: owner.result.sessionId, method: "Page.enable" });
    advance(50_000);
    assert.equal((await request(harness, "busy-1", "raw.attach", { tabId: 5 })).error.code, "debugger_target_busy");

    const invalid = await request(harness, "invalid", "raw.send", { sessionId: owner.result.sessionId, method: "" });
    assert.equal(invalid.error.code, "raw_invalid_request");
    advance(10_001);
    const takeover = await request(harness, "takeover-check", "debugger.sessions", { tabId: 5 });
    assert.equal(takeover.result.sessions[0].expired, true);

    const renewed = await request(harness, "renew", "debugger.renew", { sessionId: owner.result.sessionId, leaseTtlMs: 120_000 });
    assert.equal(renewed.ok, true);
    assert.equal(renewed.result.lease.leaseTtlMs, 120_000);
    assert.equal(renewed.result.lease.expired, false);

    // A long poll that is still waiting protects the lease past its expiry.
    await send(harness, "long-poll", "raw.poll", { sessionId: owner.result.sessionId, afterCursor: 0, timeoutMs: 25_000 });
    advance(200_000);
    const blocked = await request(harness, "busy-2", "raw.attach", { tabId: 5 });
    assert.equal(blocked.error.code, "debugger_target_busy");
    assert.equal(blocked.error.details.occupant.active, true);
    assert.equal(blocked.error.details.occupant.waiting, 1);
    await request(harness, "detach", "raw.detach", { sessionId: owner.result.sessionId });
    assert.equal(response(harness, "long-poll").result.state, "stopped");
  } finally {
    restore();
  }
});

test("a Raw-backed projection renews its root and ends with it", async () => {
  const { harness, advance, restore } = await loadHarness();
  try {
    const raw = await request(harness, "raw", "raw.attach", { tabId: 9, captureEvents: false, leaseTtlMs: 30_000 });
    const net = await request(harness, "net", "network.start", { tabId: 9, rawSessionId: raw.result.sessionId });
    advance(25_000);
    await request(harness, "net-poll", "network.poll", { sessionId: net.result.sessionId, timeoutMs: 0 });
    advance(25_000);
    assert.equal((await request(harness, "busy", "network.start", { tabId: 9 })).error.code, "debugger_target_busy");

    const stopped = await request(harness, "net-stop", "network.stop", { sessionId: net.result.sessionId });
    assert.equal(stopped.result.state, "stopped");
    assert.equal(count(harness, "detach"), 0);

    const again = await request(harness, "net-again", "network.start", { tabId: 9, rawSessionId: raw.result.sessionId });
    advance(30_001);
    const taken = await request(harness, "take", "network.start", { tabId: 9 });
    assert.equal(taken.ok, true);
    assert.equal(taken.result.attachmentOwner, "network");
    assert.equal(taken.result.reclaimed.sessionId, raw.result.sessionId);
    const ended = await request(harness, "ended-poll", "network.poll", { sessionId: again.result.sessionId, timeoutMs: 0 });
    assert.equal(ended.result.state, "detached");

    // The reclaimed projection's stop cannot detach the new network owner.
    await request(harness, "old-net-stop", "network.stop", { sessionId: again.result.sessionId });
    assert.equal(count(harness, "detach"), 1);
    const list = await request(harness, "list", "debugger.sessions", {});
    assert.equal(list.result.sessions[0].sessionId, taken.result.sessionId);
  } finally {
    restore();
  }
});

test("concurrent attaches to one tab yield one attachment; other tabs are unaffected", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const gate = deferred();
    harness.gates.attach = gate.promise;
    await send(harness, "first", "raw.attach", { tabId: 3 });
    await flush();
    const second = await request(harness, "second", "network.start", { tabId: 3 });
    assert.equal(second.error.code, "debugger_target_busy");
    assert.equal(second.error.details.occupant.kind, "raw");
    assert.equal(second.error.details.occupant.state, "changing");

    harness.gates.attach = null;
    const other = await request(harness, "other-tab", "raw.attach", { tabId: 4 });
    assert.equal(other.ok, true);

    gate.resolve();
    await flush();
    assert.equal(response(harness, "first").ok, true);
    assert.equal(harness.debuggerCalls.filter((call) => call[0] === "attach" && call[1].tabId === 3).length, 1);
  } finally {
    restore();
  }
});

test("in-flight commands block takeover until Chrome settles them", async () => {
  const { harness, advance, restore } = await loadHarness();
  try {
    const owner = await request(harness, "attach", "raw.attach", { tabId: 11, leaseTtlMs: 30_000 });
    const gate = deferred();
    harness.gates.command = gate.promise;
    await send(harness, "slow", "raw.send", { sessionId: owner.result.sessionId, method: "Slow.command" });
    await flush();
    advance(120_000);
    const busy = await request(harness, "busy", "raw.attach", { tabId: 11 });
    assert.equal(busy.error.code, "debugger_target_busy");
    assert.equal(busy.error.details.occupant.inFlight, 1);
    assert.equal(count(harness, "detach"), 0);

    gate.resolve();
    await flush();
    assert.equal(response(harness, "slow").ok, true);
    advance(30_001);
    const taken = await request(harness, "taken", "raw.attach", { tabId: 11 });
    assert.equal(taken.ok, true);
    assert.equal(taken.result.reclaimed.sessionId, owner.result.sessionId);
  } finally {
    restore();
  }
});

test("manual recovery guards against a changed holder and needs confirmation for a live lease", async () => {
  const { harness, advance, restore } = await loadHarness();
  try {
    const owner = await request(harness, "attach", "raw.attach", { tabId: 21, leaseTtlMs: 30_000 });
    const missing = await request(harness, "none", "debugger.recover", { tabId: 22, expectedSessionId: owner.result.sessionId });
    assert.equal(missing.error.code, "debugger_session_not_found");

    const changed = await request(harness, "changed", "debugger.recover", {
      tabId: 21, expectedSessionId: "raw_00000000-0000-0000-0000-000000000000", confirmed: true,
    });
    assert.equal(changed.error.code, "debugger_session_changed");
    assert.equal(changed.error.details.occupant.sessionId, owner.result.sessionId);

    const unconfirmed = await request(harness, "unconfirmed", "debugger.recover", { tabId: 21, expectedSessionId: owner.result.sessionId });
    assert.equal(unconfirmed.error.code, "confirmation_required");
    assert.equal(count(harness, "detach"), 0);

    const confirmed = await request(harness, "confirmed", "debugger.recover", {
      tabId: 21, expectedSessionId: owner.result.sessionId, confirmed: true,
    });
    assert.equal(confirmed.ok, true);
    assert.equal(confirmed.result.previous.sessionId, owner.result.sessionId);
    assert.equal(count(harness, "detach"), 1);
    const poll = await request(harness, "poll", "raw.poll", { sessionId: owner.result.sessionId, timeoutMs: 0 });
    assert.equal(poll.result.state, "reclaimed");

    const next = await request(harness, "next", "raw.attach", { tabId: 21, leaseTtlMs: 30_000 });
    advance(30_001);
    const expired = await request(harness, "expired", "debugger.recover", { tabId: 21, expectedSessionId: next.result.sessionId });
    assert.equal(expired.ok, true);
  } finally {
    restore();
  }
});

test("a Chrome-side detach frees the tab without a takeover", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const owner = await request(harness, "attach", "raw.attach", { tabId: 31 });
    const net = await request(harness, "net", "network.start", { tabId: 31, rawSessionId: owner.result.sessionId });
    harness.debuggerDetach.listener({ tabId: 31 }, "canceled_by_user");
    const poll = await request(harness, "poll", "network.poll", { sessionId: net.result.sessionId, timeoutMs: 0 });
    assert.equal(poll.result.state, "detached");
    const next = await request(harness, "next", "raw.attach", { tabId: 31 });
    assert.equal(next.ok, true);
    assert.equal(next.result.reclaimed, undefined);
    const lease = await request(harness, "list", "debugger.sessions", { tabId: 31 });
    assert.equal(lease.result.sessions[0].sessionId, next.result.sessionId);
  } finally {
    restore();
  }
});

test("lease parameters are bounded", async () => {
  const { harness, restore } = await loadHarness();
  try {
    const tooShort = await request(harness, "short", "raw.attach", { tabId: 1, leaseTtlMs: 1_000 });
    assert.equal(tooShort.error.code, "invalid_request");
    const tooLong = await request(harness, "long", "network.start", { tabId: 1, leaseTtlMs: 2 * 60 * 60_000 });
    assert.equal(tooLong.error.code, "invalid_request");
    assert.equal(count(harness, "attach"), 0);
  } finally {
    restore();
  }
});
