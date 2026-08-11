import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("native host forwards authenticated loopback RPC to the extension stream", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-host-test-"));
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    if (!child.killed) child.kill("SIGTERM");
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const decoder = new NativeMessageDecoder();
  const messages = [];
  const waiters = [];
  child.stdout.on("data", (chunk) => {
    for (const message of decoder.push(chunk)) {
      const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(message));
      if (waiterIndex >= 0) {
        const [waiter] = waiters.splice(waiterIndex, 1);
        clearTimeout(waiter.timeout);
        waiter.resolve(message);
      } else messages.push(message);
    }
  });

  function nextMessage(predicate) {
    const existingIndex = messages.findIndex(predicate);
    if (existingIndex >= 0) return Promise.resolve(messages.splice(existingIndex, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timeout = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("Timed out waiting for native host message"));
      }, 2_000);
      waiters.push(waiter);
    });
  }

  await nextMessage((message) => message.type === "ready");
  child.stdin.write(
    encodeNativeMessage({ type: "hello", extensionVersion: "0.6.0" }),
  );
  const runtime = JSON.parse(await fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8"));
  const initialAuth = JSON.parse(await fs.readFile(path.join(bridgeDir, "auth.json"), "utf8"));
  assert.equal(runtime.schemaVersion, 2);
  assert.equal("token" in runtime, false);

  child.stdin.write(encodeNativeMessage({ type: "auth.request", id: "auth-get", action: "get" }));
  const getAuth = await nextMessage((message) => message.type === "auth.response" && message.id === "auth-get");
  assert.equal(getAuth.ok, true);
  assert.equal(getAuth.result.token, initialAuth.token);

  child.stdin.write(encodeNativeMessage({ type: "auth.request", id: "auth-renew", action: "renew" }));
  const renewAuth = await nextMessage((message) => message.type === "auth.response" && message.id === "auth-renew");
  assert.equal(renewAuth.ok, true);
  assert.notEqual(renewAuth.result.token, initialAuth.token);
  const persistedAuth = JSON.parse(await fs.readFile(path.join(bridgeDir, "auth.json"), "utf8"));
  assert.equal(persistedAuth.token, renewAuth.result.token);

  const rejected = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${initialAuth.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "browser.status", params: {} }),
  });
  assert.equal(rejected.status, 401);

  const rpcPromise = fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${renewAuth.result.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ method: "browser.status", params: {} }),
  });

  const request = await nextMessage((message) => message.type === "request");
  assert.equal(request.method, "browser.status");
  child.stdin.write(
    encodeNativeMessage({
      type: "response",
      id: request.id,
      ok: true,
      result: { connected: true, extensionVersion: "test" },
    }),
  );

  const response = await rpcPromise;
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    result: { connected: true, extensionVersion: "test" },
  });

  child.stdin.write(
    encodeNativeMessage({
      type: "event",
      event: "tab.updated",
      data: { tabId: 42, changeInfo: { status: "complete" } },
    }),
  );
  const eventsResponse = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${renewAuth.result.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      method: "events.poll",
      params: { afterSequence: 0, tabId: 42, timeoutMs: 0 },
    }),
  });
  const eventsPayload = await eventsResponse.json();
  assert.equal(eventsPayload.ok, true);
  assert.equal(eventsPayload.result.cursor, 1);
  assert.equal(eventsPayload.result.events[0].event, "tab.updated");
  assert.equal(eventsPayload.result.events[0].data.tabId, 42);

  child.stdin.end();
});
