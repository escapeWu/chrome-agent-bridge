import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function event() {
  return { listener: null, addListener(listener) { this.listener = listener; } };
}

test("service worker proxies popup token requests only through native messaging", async () => {
  const nativeMessages = [];
  const nativeMessage = event();
  const nativeDisconnect = event();
  const runtimeMessage = event();
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
      onMessage: runtimeMessage,
    },
    action: { onClicked: passiveEvent() },
    tabs: {
      onCreated: passiveEvent(),
      onUpdated: passiveEvent(),
      onRemoved: passiveEvent(),
      onActivated: passiveEvent(),
    },
  };

  try {
    await import(`${pathToFileURL(path.join(root, "extension/service-worker.js"))}?test=${Date.now()}`);
    let popupResponse;
    const asyncResponse = runtimeMessage.listener(
      { type: "auth.get" },
      { id: globalThis.chrome.runtime.id },
      (response) => { popupResponse = response; },
    );
    assert.equal(asyncResponse, true);
    const request = nativeMessages.find((message) => message.type === "auth.request");
    assert.equal(request.action, "get");

    const token = `cab_${Buffer.alloc(32, 5).toString("base64url")}`;
    await nativeMessage.listener({
      type: "auth.response",
      id: request.id,
      ok: true,
      result: { token, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z" },
    }, port);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(popupResponse, {
      ok: true,
      result: { token, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z" },
    });
  } finally {
    globalThis.chrome = previousChrome;
  }
});
