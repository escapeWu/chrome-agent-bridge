import assert from "node:assert/strict";
import test from "node:test";
import { CdpAnalysisManager } from "../lib/cdp-analysis.mjs";

function fakeBridge() {
  const calls = [];
  let emitted = false;
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "raw.send") {
      if (params.method === "Debugger.getScriptSource") {
        return { result: { scriptSource: "function alpha(v) { return beta(v); }\nfunction beta(v) { return v + 1; }\n//# sourceMappingURL=app.js.map" } };
      }
      if (params.method === "Network.getResponseBody") return { result: { body: "secret-response", base64Encoded: false } };
      if (params.method === "Runtime.evaluate") return { result: { result: { type: "number", value: 7 } } };
      if (params.method === "Debugger.setBreakpoint") return { result: { breakpointId: "bp-1", actualLocation: params.params.location } };
      return { result: {} };
    }
    if (method === "raw.poll") {
      if (emitted) return { captureEvents: true, events: [], cursor: params.afterCursor, latestCursor: 6, dropped: 0, truncated: false, hasMore: false, state: "running" };
      emitted = true;
      const source = { tabId: 1 };
      return {
        captureEvents: true,
        cursor: 6,
        latestCursor: 6,
        dropped: 0,
        truncated: false,
        hasMore: false,
        state: "running",
        events: [
          { cursor: 1, source, method: "Debugger.scriptParsed", params: { scriptId: "1", url: "https://example.com/app.js", sourceMapURL: "app.js.map" } },
          { cursor: 2, source, method: "Network.requestWillBeSent", params: { requestId: "req-1", timestamp: 1, wallTime: 1_700_000_000, type: "Fetch", request: { method: "POST", url: "https://example.com/api", headers: { Authorization: "Bearer secret" }, postData: "x=1" } } },
          { cursor: 3, source, method: "Network.responseReceived", params: { requestId: "req-1", response: { status: 200, statusText: "OK", url: "https://example.com/api", headers: { "Content-Type": "application/json" }, mimeType: "application/json", protocol: "h2" } } },
          { cursor: 4, source, method: "Network.loadingFinished", params: { requestId: "req-1", timestamp: 1.25, encodedDataLength: 42 } },
          { cursor: 5, source, method: "Runtime.exceptionThrown", params: { exceptionDetails: { text: "boom" } } },
          { cursor: 6, source, method: "Debugger.paused", params: { reason: "other", callFrames: [{ callFrameId: "frame-1", functionName: "alpha", location: { scriptId: "1", lineNumber: 0, columnNumber: 0 }, scopeChain: [] }] } },
        ],
      };
    }
    throw new Error(`Unexpected bridge method: ${method}`);
  };
  return { call, calls };
}

test("CDP analysis shares one event cursor across scripts, debugger, and network", async () => {
  const bridge = fakeBridge();
  const manager = new CdpAnalysisManager(bridge.call);
  const sessionId = "raw_12345678901234567890";

  const collected = await manager.collectCode({ sessionId, includeSource: true, maxScripts: 10, maxSourceBytes: 100_000 });
  assert.equal(collected.scriptCount, 1);
  assert.match(collected.scripts[0].source, /function alpha/);
  assert.equal(manager.searchScripts({ collectionId: sessionId, query: "beta" }).total >= 2, true);
  assert.equal(manager.extractFunctionTree({ collectionId: sessionId, functionName: "alpha" }).tree.dependencies[0].name, "beta");

  const paused = manager.getPausedState(sessionId);
  assert.equal(paused.paused.callFrames[0].functionName, "alpha");
  assert.equal(manager.getCallStack(sessionId).reason, "other");

  const stats = await manager.networkStats({ sessionId });
  assert.equal(stats.completed, 1);
  assert.equal(stats.bytes, 42);
  const auth = await manager.extractAuth({ sessionId, confirmed: true });
  assert.equal(auth.findings[0].value, "Bearer secret");
  const body = await manager.networkBody({ sessionId, requestId: "req-1" });
  assert.equal(body.body, "secret-response");

  const evaluated = await manager.debuggerEvaluate({ sessionId, expression: "3 + 4" });
  assert.equal(evaluated.value, 7);
  assert.ok(bridge.calls.some((entry) => entry.params?.method === "Debugger.enable"));
});

test("CDP analysis rejects event-dependent tools on captureEvents=false sessions", async () => {
  const manager = new CdpAnalysisManager(async (method) => {
    if (method === "raw.send") return { result: {} };
    return { captureEvents: false, events: [], cursor: 0, latestCursor: 0, dropped: 0, truncated: false, hasMore: false, state: "running" };
  });
  await assert.rejects(
    manager.collectCode({ sessionId: "raw_12345678901234567890", includeSource: false }),
    (error) => error.code === "raw_events_required",
  );
});

test("CDP analysis clears sensitive in-memory state when a Raw session detaches", async () => {
  const bridge = fakeBridge();
  const manager = new CdpAnalysisManager(bridge.call);
  const sessionId = "raw_12345678901234567890";

  await manager.collectCode({ sessionId, includeSource: true, maxScripts: 10, maxSourceBytes: 100_000 });
  assert.equal(manager.searchScripts({ collectionId: sessionId, query: "Bearer secret" }).total, 0);
  assert.equal(manager.searchScripts({ collectionId: sessionId, query: "function alpha" }).total, 1);

  assert.equal(manager.clearSession(sessionId), true);
  assert.equal(manager.searchScripts({ collectionId: sessionId, query: "function alpha" }).total, 0);
});
