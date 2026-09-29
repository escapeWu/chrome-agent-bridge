import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callBridge } from "../lib/bridge-client.mjs";
import {
  bridgeBindPort,
  formatHostForUrl,
  isValidHost,
  parseHostList,
  resolveConnectHost,
  runtimeAllowedHosts,
} from "../lib/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = `cab_${"a".repeat(43)}`;

function withEnv(key, value, callback) {
  const previous = process.env[key];
  process.env[key] = value;
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      if (previous == null) delete process.env[key];
      else process.env[key] = previous;
    });
}

async function waitForRuntime(bridgeDir, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await fs.readFile(path.join(bridgeDir, "runtime.json"), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Timed out waiting for runtime.json");
}

test("host parsing and validation reject URLs, ports, and blanks", () => {
  assert.deepEqual(parseHostList("127.0.0.1, 192.0.2.10"), ["127.0.0.1", "192.0.2.10"]);
  assert.deepEqual(parseHostList(["a", " b "]), ["a", "b"]);
  assert.deepEqual(parseHostList(undefined), []);

  assert.equal(isValidHost("192.0.2.10"), true);
  assert.equal(isValidHost("::1"), true);
  assert.equal(isValidHost("localhost"), true);
  assert.equal(isValidHost("bridge.lan"), true);

  assert.equal(isValidHost("evil.com:9999"), false);
  assert.equal(isValidHost("http://evil"), false);
  assert.equal(isValidHost("user@host"), false);
  assert.equal(isValidHost("bad host"), false);
  assert.equal(isValidHost(""), false);
  assert.equal(isValidHost(42), false);
});

test("formatHostForUrl brackets IPv6 literals", () => {
  assert.equal(formatHostForUrl("127.0.0.1"), "127.0.0.1");
  assert.equal(formatHostForUrl("192.0.2.10"), "192.0.2.10");
  assert.equal(formatHostForUrl("::1"), "[::1]");
  assert.equal(formatHostForUrl("[::1]"), "[::1]");
});

test("an undeclared non-loopback runtime host is not trusted", () => {
  const declared = runtimeAllowedHosts({
    host: "127.0.0.1",
    hosts: ["127.0.0.1", "192.0.2.10"],
  });
  assert.deepEqual([...declared].sort(), ["127.0.0.1", "192.0.2.10"]);
  assert.equal(resolveConnectHost({ host: "127.0.0.1" }, declared), "127.0.0.1");
  assert.equal(
    resolveConnectHost({ host: "127.0.0.1" }, declared, { CHROME_AGENT_BRIDGE_CONNECT_HOST: "192.0.2.10" }),
    "192.0.2.10",
  );
  assert.throws(
    () => resolveConnectHost({ host: "127.0.0.1" }, declared, { CHROME_AGENT_BRIDGE_CONNECT_HOST: "10.0.0.9" }),
    (error) => error.code === "bridge_offline",
  );

  const loopbackOnly = runtimeAllowedHosts({ host: "10.0.0.9", hosts: ["127.0.0.1"] });
  assert.deepEqual([...loopbackOnly], ["127.0.0.1"]);
  const bareNonLoopback = runtimeAllowedHosts({ host: "10.0.0.9" });
  assert.deepEqual([...bareNonLoopback], ["127.0.0.1"]);
});

test("bridge client authenticates against a declared host", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-lan-client-"));
  const server = http.createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.statusCode = authorized ? 200 : 401;
    response.end(
      authorized
        ? JSON.stringify({ ok: true, result: { connected: true, host: "declared" } })
        : JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  await fs.writeFile(
    path.join(bridgeDir, "runtime.json"),
    JSON.stringify({ schemaVersion: 2, host: "127.0.0.1", port, hosts: ["127.0.0.1"], pid: 1, startedAt: "x" }),
  );
  await fs.writeFile(
    path.join(bridgeDir, "auth.json"),
    JSON.stringify({ schemaVersion: 1, token: TOKEN, createdAt: "x", rotatedAt: "x" }),
  );

  await withEnv("CHROME_AGENT_BRIDGE_DIR", bridgeDir, async () => {
    const result = await callBridge("browser.status");
    assert.deepEqual(result, { connected: true, host: "declared" });
  });
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("bridgeBindPort prefers the environment and validates its range", async () => {
  assert.equal(await bridgeBindPort({ CHROME_AGENT_BRIDGE_PORT: "42359" }), 42359);
  assert.equal(await bridgeBindPort({}), 0);
  await assert.rejects(
    () => bridgeBindPort({ CHROME_AGENT_BRIDGE_PORT: "70000" }),
    (error) => error.code === "invalid_port",
  );
  await assert.rejects(
    () => bridgeBindPort({ CHROME_AGENT_BRIDGE_PORT: "abc" }),
    (error) => error.code === "invalid_port",
  );
});

test("bridge client can pin a remote endpoint without runtime.json", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-remote-"));
  const server = http.createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.statusCode = authorized ? 200 : 401;
    response.end(
      authorized
        ? JSON.stringify({ ok: true, result: { connected: true, pinned: true } })
        : JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  context.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  // No runtime.json is written: the client must fall back to the pinned env endpoint.
  await withEnv("CHROME_AGENT_BRIDGE_DIR", bridgeDir, () =>
    withEnv("CHROME_AGENT_BRIDGE_CONNECT_HOST", "127.0.0.1", () =>
      withEnv("CHROME_AGENT_BRIDGE_PORT", String(port), () =>
        withEnv("CHROME_AGENT_BRIDGE_TOKEN", TOKEN, async () => {
          const result = await callBridge("browser.status");
          assert.deepEqual(result, { connected: true, pinned: true });
        }),
      ),
    ),
  );

  await withEnv("CHROME_AGENT_BRIDGE_DIR", bridgeDir, () =>
    withEnv("CHROME_AGENT_BRIDGE_CONNECT_HOST", "127.0.0.1", async () => {
      delete process.env.CHROME_AGENT_BRIDGE_PORT;
      await assert.rejects(
        () => callBridge("browser.status"),
        (error) => error.code === "bridge_offline",
      );
    }),
  );
});

test("native host honors a fixed port", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-port-"));
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      CHROME_AGENT_BRIDGE_BIND_HOSTS: "127.0.0.1",
      CHROME_AGENT_BRIDGE_PORT: String(port),
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  context.after(async () => {
    if (!child.killed) child.kill("SIGTERM");
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const runtime = await waitForRuntime(bridgeDir);
  assert.equal(runtime.port, port);
  assert.deepEqual(runtime.hosts, ["127.0.0.1"]);
});

test("native host binds every configured address on one shared port", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-lan-host-"));
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
      CHROME_AGENT_BRIDGE_BIND_HOSTS: "127.0.0.1,127.0.0.2",
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  context.after(async () => {
    if (!child.killed) child.kill("SIGTERM");
    await fs.rm(bridgeDir, { recursive: true, force: true });
  });

  const runtime = await waitForRuntime(bridgeDir);
  assert.equal(runtime.schemaVersion, 2);
  assert.ok(Array.isArray(runtime.hosts));
  assert.ok(runtime.hosts.includes("127.0.0.1"));
  assert.equal(runtime.host, "127.0.0.1");
  assert.equal("token" in runtime, false);

  const unauthenticated = await fetch(`http://127.0.0.1:${runtime.port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: "browser.status", params: {} }),
  });
  assert.equal(unauthenticated.status, 401);

  if (runtime.hosts.includes("127.0.0.2")) {
    const secondary = await fetch(`http://127.0.0.2:${runtime.port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "browser.status", params: {} }),
    });
    assert.equal(secondary.status, 401);
  }
});
