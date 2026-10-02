import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function loadWorker(store) {
  const nativeMessages = [];
  const nativeMessage = event();
  const runtimeMessage = event();
  const port = {
    onMessage: nativeMessage,
    onDisconnect: event(),
    postMessage(message) { nativeMessages.push(message); },
  };
  const passive = () => event();
  globalThis.chrome = {
    runtime: {
      id: "hkedmoboloodflgcaidimhddljdnndcd",
      connectNative: () => port,
      getManifest: () => ({ version: "0.8.0" }),
      onInstalled: passive(),
      onStartup: passive(),
      onMessage: runtimeMessage,
    },
    action: { onClicked: passive() },
    tabs: { onCreated: passive(), onUpdated: passive(), onRemoved: passive(), onActivated: passive() },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
      },
    },
  };
  await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?instance=${Math.random()}`);
  await settle();
  const ask = (message) => new Promise((resolve) => {
    runtimeMessage.listener(message, { id: globalThis.chrome.runtime.id }, resolve);
  });
  return { nativeMessages, nativeMessage, port, ask };
}

test("service worker keeps a stable per-profile identity and reports it in hello", async () => {
  const previous = globalThis.chrome;
  const store = {};
  try {
    const first = await loadWorker(store);
    const hello = first.nativeMessages.find((message) => message.type === "hello");
    assert.match(hello.instanceId, /^inst_[0-9a-f]{12}$/);
    assert.equal(hello.label, `Chrome-${hello.instanceId.slice(-4)}`);
    assert.equal(store.instanceId, hello.instanceId);

    // A later start (new service worker) reads the same stored identity.
    const second = await loadWorker(store);
    assert.equal(second.nativeMessages.find((message) => message.type === "hello").instanceId, hello.instanceId);
  } finally {
    globalThis.chrome = previous;
  }
});

test("renaming pushes the new label to the native host", async () => {
  const previous = globalThis.chrome;
  try {
    const worker = await loadWorker({});
    const got = await worker.ask({ type: "instance.get" });
    assert.equal(got.ok, true);
    const renamed = await worker.ask({ type: "instance.rename", label: "  Work   profile " });
    assert.equal(renamed.result.label, "Work profile");
    assert.equal(renamed.result.instanceId, got.result.instanceId);
    assert.deepEqual(worker.nativeMessages.at(-1), { type: "instance.update", label: "Work profile" });
    const blank = await worker.ask({ type: "instance.rename", label: "   " });
    assert.equal(blank.result.label, `Chrome-${got.result.instanceId.slice(-4)}`);
  } finally {
    globalThis.chrome = previous;
  }
});

test("an instance conflict from the host triggers a fresh identity", async () => {
  const previous = globalThis.chrome;
  const store = {};
  try {
    const worker = await loadWorker(store);
    const original = worker.nativeMessages.find((message) => message.type === "hello");
    await worker.nativeMessage.listener({ type: "instance.conflict", instanceId: original.instanceId }, worker.port);
    await settle();
    const hellos = worker.nativeMessages.filter((message) => message.type === "hello");
    assert.equal(hellos.length, 2);
    assert.notEqual(hellos[1].instanceId, original.instanceId);
    assert.equal(store.instanceId, hellos[1].instanceId);
  } finally {
    globalThis.chrome = previous;
  }
});
