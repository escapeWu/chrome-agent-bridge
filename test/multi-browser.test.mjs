import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { callBridge, listBrowserInstances } from "../lib/bridge-client.mjs";
import { bridgePortCandidates } from "../lib/config.mjs";
import {
  listInstances,
  normalizeLabel,
  prefixSessionId,
  readInstanceRecord,
  selectInstance,
  splitSessionId,
  writeInstanceRecord,
} from "../lib/instance-registry.mjs";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function withBridgeDir(callback) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-multi-"));
  const previous = process.env.CHROME_AGENT_BRIDGE_DIR;
  const previousInstance = process.env.CHROME_AGENT_BRIDGE_INSTANCE;
  process.env.CHROME_AGENT_BRIDGE_DIR = dir;
  delete process.env.CHROME_AGENT_BRIDGE_INSTANCE;
  try {
    return await callback(dir);
  } finally {
    if (previous == null) delete process.env.CHROME_AGENT_BRIDGE_DIR;
    else process.env.CHROME_AGENT_BRIDGE_DIR = previous;
    if (previousInstance != null) process.env.CHROME_AGENT_BRIDGE_INSTANCE = previousInstance;
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const record = (instanceId, label, extra = {}) => ({
  instanceId,
  label,
  host: "127.0.0.1",
  hosts: ["127.0.0.1"],
  port: 40000,
  pid: process.pid,
  startedAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

test("session IDs round-trip through the instance prefix", () => {
  const prefixed = prefixSessionId("inst_ab12cd34ef56", "raw_0123456789abcdef");
  assert.deepEqual(splitSessionId(prefixed), { instanceId: "inst_ab12cd34ef56", sessionId: "raw_0123456789abcdef" });
  assert.deepEqual(splitSessionId("raw_0123456789abcdef"), { instanceId: null, sessionId: "raw_0123456789abcdef" });
  assert.equal(normalizeLabel("  Work\u0000  account \n", "inst_abcdef123456"), "Work account");
  assert.equal(normalizeLabel("", "inst_abcdef123456"), "Chrome-3456");
});

test("selectInstance resolves by ID or label and refuses to guess", () => {
  const one = record("inst_aaaaaaaaaaaa", "Work");
  const two = record("inst_bbbbbbbbbbbb", "Personal");
  assert.equal(selectInstance([one], undefined), one);
  assert.equal(selectInstance([one, two], "inst_bbbbbbbbbbbb"), two);
  assert.equal(selectInstance([one, two], " personal "), two);
  assert.throws(() => selectInstance([one, two]), (error) => error.code === "browser_ambiguous" && error.instances.length === 2);
  assert.throws(() => selectInstance([one, two], "nope"), (error) => error.code === "browser_not_found");
  assert.throws(
    () => selectInstance([one, record("inst_cccccccccccc", "work")], "WORK"),
    (error) => error.code === "browser_ambiguous",
  );
  assert.throws(() => selectInstance([]), (error) => error.code === "browser_not_found");
});

test("registry lists live instances and prunes records of dead hosts", async () => {
  await withBridgeDir(async (dir) => {
    await writeInstanceRecord(record("inst_aaaaaaaaaaaa", "Live"));
    await writeInstanceRecord(record("inst_bbbbbbbbbbbb", "Dead", { pid: 2 ** 22 + 12345 }));
    await fs.writeFile(path.join(dir, "instances", "inst_cccccccccccc.json"), "{not json");
    const instances = await listInstances();
    assert.deepEqual(instances.map((item) => item.label), ["Live"]);
    assert.equal(await readInstanceRecord("inst_bbbbbbbbbbbb"), null);
    const stat = await fs.stat(path.join(dir, "instances", "inst_aaaaaaaaaaaa.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  });
});

test("port range yields ordered candidates and rejects bad ranges", async () => {
  assert.deepEqual(await bridgePortCandidates({ CHROME_AGENT_BRIDGE_DIR: "/nonexistent", CHROME_AGENT_BRIDGE_PORT_RANGE: "42360-42362" }), [42360, 42361, 42362]);
  assert.deepEqual(await bridgePortCandidates({ CHROME_AGENT_BRIDGE_DIR: "/nonexistent", CHROME_AGENT_BRIDGE_PORT: "43000", CHROME_AGENT_BRIDGE_PORT_RANGE: "42360-42362" }), [43000]);
  assert.deepEqual(await bridgePortCandidates({ CHROME_AGENT_BRIDGE_DIR: "/nonexistent" }), [0]);
  await assert.rejects(bridgePortCandidates({ CHROME_AGENT_BRIDGE_DIR: "/nonexistent", CHROME_AGENT_BRIDGE_PORT_RANGE: "5-2" }), (error) => error.code === "invalid_port");
});

/** A stand-in native host: records the RPCs it receives and answers them. */
function fakeBridge(label) {
  const calls = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const { method, params } = JSON.parse(body);
      calls.push({ method, params });
      const holder = `raw_${label.padEnd(24, "0")}`;
      if (method === "raw.attach" && params.tabId === 99) {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          ok: false,
          error: {
            code: "debugger_target_busy",
            message: "busy",
            details: { tabId: 99, occupant: { sessionId: holder, kind: "raw", projections: [{ sessionId: `net_${label}`, rawSessionId: holder }] } },
          },
        }));
        return;
      }
      const result = method === "raw.attach" ? { sessionId: holder, tabId: params.tabId }
        : method === "debugger.sessions" ? { sessions: [{ sessionId: holder, projections: [{ sessionId: `net_${label}`, rawSessionId: holder }] }] }
        : method === "raw.send" ? { result: { sessionId: "cdp-target-session" } }
        : method === "tabs.list" ? [{ id: 1, title: label }]
        : method === "browser.status" ? { connected: true, extensionVersion: "0.8.0" }
        : { ok: true, params };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port })));
}

test("callBridge routes by selector and session prefix, and strips routing fields", async (context) => {
  await withBridgeDir(async (dir) => {
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
      schemaVersion: 1, token: `cab_${"a".repeat(43)}`, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const work = await fakeBridge("work");
    const home = await fakeBridge("home");
    context.after(() => { work.server.close(); home.server.close(); });
    await writeInstanceRecord(record("inst_workworkwork", "Work", { port: work.port }));
    await writeInstanceRecord(record("inst_homehomehome", "Home", { port: home.port }));

    await assert.rejects(callBridge("tabs.list"), (error) => error.code === "browser_ambiguous");
    assert.equal(work.calls.length + home.calls.length, 0);

    const route = {};
    const tabs = await callBridge("tabs.list", { browser: "home" }, { route });
    assert.equal(tabs[0].title, "home");
    assert.deepEqual(route, { instanceId: "inst_homehomehome", label: "Home" });
    assert.deepEqual(home.calls.at(-1), { method: "tabs.list", params: {} });

    const attached = await callBridge("raw.attach", { browser: "inst_workworkwork", tabId: 7 });
    assert.equal(attached.sessionId.startsWith("inst_workworkwork~raw_work"), true);
    assert.equal(work.calls.at(-1).params.browser, undefined);

    // A later call needs no selector: the session ID carries the instance.
    await callBridge("raw.send", { sessionId: attached.sessionId, method: "Page.enable", params: {} });
    assert.equal(work.calls.at(-1).params.sessionId, attached.sessionId.split("~")[1]);
    assert.equal(home.calls.some((call) => call.method === "raw.send"), false);

    await assert.rejects(
      callBridge("raw.send", { browser: "Home", sessionId: attached.sessionId, method: "x" }),
      (error) => error.code === "browser_mismatch",
    );

    process.env.CHROME_AGENT_BRIDGE_INSTANCE = "Home";
    try {
      assert.equal((await callBridge("tabs.list"))[0].title, "home");
    } finally {
      delete process.env.CHROME_AGENT_BRIDGE_INSTANCE;
    }

    const listed = await listBrowserInstances();
    assert.deepEqual(listed.map((item) => item.label).sort(), ["Home", "Work"]);
  });
});

test("nested debugger session IDs and busy details carry the owning browser", async (context) => {
  await withBridgeDir(async (dir) => {
    await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
      schemaVersion: 1, token: `cab_${"a".repeat(43)}`, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z",
    }), { mode: 0o600 });
    const work = await fakeBridge("work");
    const home = await fakeBridge("home");
    context.after(() => { work.server.close(); home.server.close(); });
    await writeInstanceRecord(record("inst_workworkwork", "Work", { port: work.port }));
    await writeInstanceRecord(record("inst_homehomehome", "Home", { port: home.port }));

    const listed = await callBridge("debugger.sessions", { browser: "Work" });
    assert.equal(listed.sessions[0].sessionId, "inst_workworkwork~raw_work00000000000000000000");
    assert.equal(listed.sessions[0].projections[0].sessionId, "inst_workworkwork~net_work");
    assert.equal(listed.sessions[0].projections[0].rawSessionId, "inst_workworkwork~raw_work00000000000000000000");

    // Raw CDP payloads are never rewritten, even when they contain a sessionId.
    const sent = await callBridge("raw.send", { sessionId: "inst_workworkwork~raw_x", method: "Target.attachToTarget" });
    assert.equal(sent.result.sessionId, "cdp-target-session");

    // The same tab number in another profile is a different tab: Work's holder
    // never blocks Home.
    await assert.rejects(callBridge("raw.attach", { browser: "Work", tabId: 99 }), (error) => {
      assert.equal(error.code, "debugger_target_busy");
      assert.deepEqual(error.details.browser, { instanceId: "inst_workworkwork", label: "Work" });
      assert.equal(error.details.occupant.sessionId, "inst_workworkwork~raw_work00000000000000000000");
      assert.equal(error.details.occupant.projections[0].sessionId, "inst_workworkwork~net_work");
      return true;
    });
    assert.equal(home.calls.length, 0);

    // Credential fields route by their prefix and conflict with another browser.
    await callBridge("page.act", { tabId: 99, kind: "press", debuggerSessionId: "inst_homehomehome~raw_h" });
    assert.equal(home.calls.at(-1).params.debuggerSessionId, "raw_h");
    await callBridge("debugger.recover", { tabId: 99, expectedSessionId: "inst_homehomehome~raw_h" });
    assert.equal(home.calls.at(-1).params.expectedSessionId, "raw_h");
    await assert.rejects(
      callBridge("debugger.recover", { browser: "Work", tabId: 99, expectedSessionId: "inst_homehomehome~raw_h" }),
      (error) => error.code === "browser_mismatch",
    );
  });
});

/** Spawn a real native host sharing one bridge directory and complete its hello. */
async function startHost(context, bridgeDir, instanceId, label) {
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: bridgeDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(() => child.kill("SIGTERM"));
  const decoder = new NativeMessageDecoder();
  const seen = [];
  child.stdout.on("data", (chunk) => seen.push(...decoder.push(chunk)));
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const found = seen.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for native host message");
  };
  await waitFor((message) => message.type === "ready");
  child.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.8.0", instanceId, label }));
  await waitFor((message) => message.type === "hello");
  return { child, seen, waitFor };
}

async function waitForInstances(count) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const instances = await listInstances();
    if (instances.length === count) return instances;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} registered instances`);
}

test("two native hosts register separately and route RPCs to their own extension", async (context) => {
  await withBridgeDir(async (dir) => {
    const first = await startHost(context, dir, "inst_firstfirstfi", "Work");
    const second = await startHost(context, dir, "inst_secondsecond", "Personal");
    const instances = await waitForInstances(2);
    assert.deepEqual(instances.map((item) => item.label).sort(), ["Personal", "Work"]);
    assert.notEqual(instances[0].port, instances[1].port);

    // Each host answers its own extension: echo the request id back with the label.
    for (const [host, name] of [[first, "Work"], [second, "Personal"]]) {
      host.child.stdout.on("data", () => {
        for (const message of host.seen.splice(0)) {
          if (message.type === "request") {
            host.child.stdin.write(encodeNativeMessage({ type: "response", id: message.id, ok: true, result: { served: name } }));
          }
        }
      });
    }
    const personal = await callBridge("tabs.list", { browser: "Personal" });
    assert.deepEqual(personal, { served: "Personal" });
    const work = await callBridge("tabs.list", { browser: "inst_firstfirstfi" });
    assert.deepEqual(work, { served: "Work" });
    await assert.rejects(callBridge("tabs.list"), (error) => error.code === "browser_ambiguous");

    // A rename reaches the registry without reconnecting.
    second.child.stdin.write(encodeNativeMessage({ type: "instance.update", label: "Renamed" }));
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (await readInstanceRecord("inst_secondsecond"))?.label !== "Renamed") {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal((await readInstanceRecord("inst_secondsecond")).label, "Renamed");

    // Stopping a host removes only its own record.
    first.child.stdin.end();
    await waitForInstances(1);
    assert.equal((await listInstances())[0].instanceId, "inst_secondsecond");
  });
});

test("a live host owning the same instance ID makes the newcomer regenerate", async (context) => {
  await withBridgeDir(async (dir) => {
    await startHost(context, dir, "inst_duplicateidxx", "Original");
    const clone = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
      cwd: root,
      env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: dir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    context.after(() => clone.kill("SIGTERM"));
    const decoder = new NativeMessageDecoder();
    const messages = [];
    clone.stdout.on("data", (chunk) => messages.push(...decoder.push(chunk)));
    await new Promise((resolve) => setTimeout(resolve, 300));
    clone.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.8.0", instanceId: "inst_duplicateidxx", label: "Copy" }));
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline && !messages.some((message) => message.type === "instance.conflict")) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(messages.some((message) => message.type === "instance.conflict"));
    assert.equal((await readInstanceRecord("inst_duplicateidxx")).label, "Original");

    clone.stdin.write(encodeNativeMessage({ type: "hello", extensionVersion: "0.8.0", instanceId: "inst_regeneratedxx", label: "Copy" }));
    await waitForInstances(2);
  });
});

test("a host skips an occupied port inside its configured range", async (context) => {
  const net = await import("node:net");
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  context.after(() => blocker.close());
  const taken = blocker.address().port;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-range-"));
  const child = spawn(process.execPath, [path.join(root, "native-host", "host.mjs")], {
    cwd: root,
    env: { ...process.env, CHROME_AGENT_BRIDGE_DIR: dir, CHROME_AGENT_BRIDGE_PORT_RANGE: `${taken}-${taken + 5}` },
    stdio: ["pipe", "pipe", "pipe"],
  });
  context.after(async () => {
    child.kill("SIGTERM");
    await fs.rm(dir, { recursive: true, force: true });
  });
  const deadline = Date.now() + 4_000;
  let runtime = null;
  while (!runtime && Date.now() < deadline) {
    runtime = await fs.readFile(path.join(dir, "runtime.json"), "utf8").then(JSON.parse, () => null);
    if (!runtime) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(runtime, "host wrote runtime.json");
  assert.ok(runtime.port > taken && runtime.port <= taken + 5);
});

test("MCP tools list browsers and refuse to guess between them", async (context) => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-mcp-multi-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, "auth.json"), JSON.stringify({
    schemaVersion: 1, token: `cab_${"a".repeat(43)}`, createdAt: "2026-01-01T00:00:00.000Z", rotatedAt: "2026-01-01T00:00:00.000Z",
  }), { mode: 0o600 });
  const work = await fakeBridge("work");
  const home = await fakeBridge("home");
  context.after(() => { work.server.close(); home.server.close(); });
  const previous = process.env.CHROME_AGENT_BRIDGE_DIR;
  process.env.CHROME_AGENT_BRIDGE_DIR = dir;
  await writeInstanceRecord(record("inst_workworkwork", "Work", { port: work.port }));
  await writeInstanceRecord(record("inst_homehomehome", "Home", { port: home.port }));
  if (previous == null) delete process.env.CHROME_AGENT_BRIDGE_DIR;
  else process.env.CHROME_AGENT_BRIDGE_DIR = previous;

  const client = new Client({ name: "multi-browser-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: { PATH: process.env.PATH || "", CHROME_AGENT_BRIDGE_DIR: dir },
    stderr: "pipe",
  }));

  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.ok(byName.browser_status.inputSchema.properties.browser);
  assert.ok(byName.browser_cdp_attach.inputSchema.properties.browser);
  assert.equal(byName.browser_cdp_send.inputSchema.properties.browser, undefined);
  assert.equal(byName.binary_decode.inputSchema.properties.browser, undefined);

  const listed = await client.callTool({ name: "browser_list_instances", arguments: {} });
  const rows = listed.structuredContent.instances;
  assert.deepEqual(rows.map((row) => [row.label, row.reachable, row.tabCount]).sort(), [["Home", true, 1], ["Work", true, 1]]);

  const ambiguous = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(ambiguous.isError, true);
  const failure = JSON.parse(ambiguous.content[0].text).error;
  assert.equal(failure.code, "browser_ambiguous");
  assert.equal(failure.instances.length, 2);

  const status = await client.callTool({ name: "browser_status", arguments: { browser: "work" } });
  assert.deepEqual(status.structuredContent.browser, { instanceId: "inst_workworkwork", label: "Work" });
});
