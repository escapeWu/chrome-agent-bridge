import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "acorn";
import * as walk from "acorn-walk";
import { callBridge } from "./bridge-client.mjs";
import { bridgeDirectory } from "./config.mjs";

const MAX_SCRIPT_SOURCE_BYTES = 3_000_000;
const MAX_ARTIFACT_BYTES = 60 * 1024 * 1024;
const SENSITIVE_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

function parseCode(code) {
  const options = { ecmaVersion: "latest", locations: true, ranges: true, allowHashBang: true, allowAwaitOutsideFunction: true };
  try { return parse(code, { ...options, sourceType: "module" }); }
  catch { return parse(code, { ...options, sourceType: "script" }); }
}

function calleeName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const left = calleeName(node.object);
    const right = node.computed ? node.property?.value : calleeName(node.property);
    return left && right != null ? `${left}.${right}` : left;
  }
  return null;
}

function stringifyRemote(remote) {
  if (!remote) return null;
  if (Object.hasOwn(remote, "value")) return remote.value;
  if (remote.unserializableValue) return remote.unserializableValue;
  return remote;
}

function normalizeHeaders(headers) {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map((item) => ({ name: String(item.name), value: String(item.value) }));
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function harHeaders(headers) {
  return normalizeHeaders(headers).map(({ name, value }) => ({ name, value }));
}

function snapshotState(state) {
  return {
    cursor: state.cursor,
    breakpoints: [...state.breakpoints.entries()],
    watches: [...state.watches.entries()],
    blackboxPatterns: [...state.blackboxPatterns],
    scripts: [...state.scripts.values()].map(({ source, ...script }) => ({ ...script, sourceBytes: source ? Buffer.byteLength(source) : 0 })),
  };
}

function targetKey(targetSessionId) {
  return targetSessionId || "root";
}

function scopedId(targetSessionId, value) {
  return `${targetKey(targetSessionId)}:${String(value || "")}`;
}

export class CdpAnalysisManager {
  #states = new Map();
  #call;

  constructor(call = callBridge) {
    this.#call = call;
  }

  state(sessionId) {
    let state = this.#states.get(sessionId);
    if (!state) {
      state = {
        cursor: 0,
        dropped: 0,
        scripts: new Map(),
        requests: new Map(),
        completedRequests: [],
        exceptions: [],
        paused: null,
        pausedByTarget: new Map(),
        breakpoints: new Map(),
        watches: new Map(),
        blackboxPatterns: [],
        savedSessions: new Map(),
        intercept: { enabled: false, patterns: [], paused: [] },
        trace: null,
        heapSnapshot: null,
        pollChain: Promise.resolve(),
      };
      this.#states.set(sessionId, state);
    }
    return state;
  }

  clearSession(sessionId) {
    return this.#states.delete(sessionId);
  }

  async send(sessionId, method, params = {}, targetSessionId, options = {}) {
    const response = await this.#call("raw.send", { sessionId, method, params, ...(targetSessionId ? { targetSessionId } : {}) }, options);
    return response.result ?? null;
  }

  async poll(sessionId, { timeoutMs = 0, limit = 200 } = {}) {
    const state = this.state(sessionId);
    const operation = state.pollChain.then(() => this.#pollUnlocked(sessionId, state, { timeoutMs, limit }));
    state.pollChain = operation.catch(() => undefined);
    return operation;
  }

  async #pollUnlocked(sessionId, state, { timeoutMs, limit }) {
    const all = [];
    let first = true;
    do {
      const result = await this.#call("raw.poll", { sessionId, afterCursor: state.cursor, limit, timeoutMs: first ? timeoutMs : 0 }, { timeoutMs: (first ? timeoutMs : 0) + 5_000 });
      first = false;
      if (result.captureEvents === false) {
        const error = new Error("This high-level analysis requires a Raw session attached with captureEvents=true");
        error.code = "raw_events_required";
        throw error;
      }
      if (result.truncated || result.dropped > state.dropped) state.truncated = true;
      state.dropped = result.dropped;
      state.cursor = Math.max(state.cursor, result.cursor || 0);
      for (const event of result.events) {
        state.cursor = Math.max(state.cursor, event.cursor || 0);
        this.#consume(state, event);
        all.push(event);
      }
      if (!result.hasMore) break;
    } while (all.length < 5_000);
    return { events: all, cursor: state.cursor, dropped: state.dropped, truncated: Boolean(state.truncated) };
  }

  #consume(state, event) {
    const params = event.params || {};
    if (event.method === "Debugger.scriptParsed") {
      const key = scopedId(event.source?.sessionId, params.scriptId);
      const previous = state.scripts.get(key) || {};
      state.scripts.set(key, {
        ...previous,
        scriptId: params.scriptId,
        url: params.url || previous.url || "",
        sourceMapURL: params.sourceMapURL || previous.sourceMapURL || "",
        startLine: params.startLine,
        startColumn: params.startColumn,
        endLine: params.endLine,
        endColumn: params.endColumn,
        executionContextId: params.executionContextId,
        hash: params.hash,
        isModule: params.isModule,
        targetSessionId: event.source?.sessionId,
      });
      return;
    }
    if (event.method === "Debugger.paused") {
      state.paused = { ...params, observedAt: event.observedAt, cursor: event.cursor, targetSessionId: event.source?.sessionId };
      state.pausedByTarget.set(targetKey(event.source?.sessionId), state.paused);
      return;
    }
    if (event.method === "Debugger.resumed") {
      state.pausedByTarget.delete(targetKey(event.source?.sessionId));
      state.paused = [...state.pausedByTarget.values()].at(-1) || null;
      return;
    }
    if (event.method === "Runtime.exceptionThrown") {
      state.exceptions.push({ ...params, observedAt: event.observedAt, targetSessionId: event.source?.sessionId });
      if (state.exceptions.length > 500) state.exceptions.shift();
      return;
    }
    if (event.method === "Fetch.requestPaused") {
      state.intercept.paused.push({ ...params, observedAt: event.observedAt, targetSessionId: event.source?.sessionId });
      if (state.intercept.paused.length > 500) state.intercept.paused.shift();
      return;
    }
    if (event.method === "Network.requestWillBeSent") {
      const requestKey = scopedId(event.source?.sessionId, params.requestId);
      const request = params.request || {};
      state.requests.set(requestKey, {
        requestId: params.requestId,
        url: request.url,
        method: request.method,
        requestHeaders: request.headers || {},
        postData: request.postData,
        resourceType: params.type,
        initiator: params.initiator,
        startedAt: params.timestamp,
        wallTime: params.wallTime,
        targetSessionId: event.source?.sessionId,
      });
      return;
    }
    if (event.method === "Network.requestWillBeSentExtraInfo") {
      const requestKey = scopedId(event.source?.sessionId, params.requestId);
      const request = state.requests.get(requestKey) || { requestId: params.requestId, targetSessionId: event.source?.sessionId };
      request.requestHeaders = { ...(request.requestHeaders || {}), ...(params.headers || {}) };
      request.associatedCookies = params.associatedCookies;
      state.requests.set(requestKey, request);
      return;
    }
    if (event.method === "Network.responseReceived") {
      const requestKey = scopedId(event.source?.sessionId, params.requestId);
      const request = state.requests.get(requestKey) || { requestId: params.requestId, targetSessionId: event.source?.sessionId };
      const response = params.response || {};
      Object.assign(request, {
        url: request.url || response.url,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: response.headers || {},
        mimeType: response.mimeType,
        protocol: response.protocol,
        remoteIPAddress: response.remoteIPAddress,
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        securityDetails: response.securityDetails,
      });
      state.requests.set(requestKey, request);
      return;
    }
    if (event.method === "Network.responseReceivedExtraInfo") {
      const requestKey = scopedId(event.source?.sessionId, params.requestId);
      const request = state.requests.get(requestKey) || { requestId: params.requestId, targetSessionId: event.source?.sessionId };
      request.responseHeaders = { ...(request.responseHeaders || {}), ...(params.headers || {}) };
      request.status = request.status || params.statusCode;
      state.requests.set(requestKey, request);
      return;
    }
    if (["Network.loadingFinished", "Network.loadingFailed"].includes(event.method)) {
      const requestKey = scopedId(event.source?.sessionId, params.requestId);
      const request = state.requests.get(requestKey) || { requestId: params.requestId, targetSessionId: event.source?.sessionId };
      Object.assign(request, {
        endedAt: params.timestamp,
        durationMs: Number.isFinite(request.startedAt) && Number.isFinite(params.timestamp) ? Number(((params.timestamp - request.startedAt) * 1_000).toFixed(3)) : null,
        encodedDataLength: params.encodedDataLength,
        failed: event.method === "Network.loadingFailed",
        errorText: params.errorText,
        canceled: params.canceled,
      });
      state.completedRequests.push(request);
      if (state.completedRequests.length > 5_000) state.completedRequests.shift();
      state.requests.delete(requestKey);
      return;
    }
    if (event.method === "Tracing.dataCollected" && state.trace && targetKey(event.source?.sessionId) === state.trace.targetKey) {
      for (const item of params.value || []) {
        const bytes = Buffer.byteLength(JSON.stringify(item));
        if (state.trace.bytes + bytes > MAX_ARTIFACT_BYTES) {
          state.trace.overflow = true;
          break;
        }
        state.trace.events.push(item);
        state.trace.bytes += bytes;
      }
    }
    if (event.method === "Tracing.tracingComplete" && state.trace && targetKey(event.source?.sessionId) === state.trace.targetKey) state.trace.complete = true;
    if (event.method === "HeapProfiler.addHeapSnapshotChunk" && state.heapSnapshot && targetKey(event.source?.sessionId) === state.heapSnapshot.targetKey) {
      state.heapSnapshot.chunks.push(params.chunk || "");
      state.heapSnapshot.bytes += Buffer.byteLength(params.chunk || "");
      if (state.heapSnapshot.bytes > MAX_ARTIFACT_BYTES) state.heapSnapshot.overflow = true;
    }
  }

  async collectCode({ sessionId, targetSessionId, waitMs = 250, includeSource = true, maxScripts = 100, maxSourceBytes = MAX_SCRIPT_SOURCE_BYTES, urlIncludes = [] }) {
    const state = this.state(sessionId);
    await this.send(sessionId, "Debugger.enable", {}, targetSessionId);
    await this.poll(sessionId, { timeoutMs: waitMs });
    const candidates = [...state.scripts.values()]
      .filter((script) => !targetSessionId || script.targetSessionId === targetSessionId)
      .filter((script) => !urlIncludes.length || urlIncludes.some((part) => script.url.includes(part)))
      .slice(0, maxScripts);
    let totalSourceBytes = 0;
    if (includeSource) {
      for (const script of candidates) {
        if (script.source != null) continue;
        try {
          const result = await this.send(sessionId, "Debugger.getScriptSource", { scriptId: script.scriptId }, script.targetSessionId || targetSessionId);
          const source = result?.scriptSource || "";
          const bytes = Buffer.byteLength(source);
          if (bytes > maxSourceBytes || totalSourceBytes + bytes > maxSourceBytes) {
            script.sourceTruncated = true;
            continue;
          }
          script.source = source;
          script.sourceBytes = bytes;
          totalSourceBytes += bytes;
          if (!script.sourceMapURL) {
            const match = source.slice(-4_096).match(/\/\/[#@]\s*sourceMappingURL\s*=\s*(\S+)/);
            if (match) script.sourceMapURL = match[1];
          }
        } catch (error) {
          script.sourceError = error.message;
        }
      }
    }
    return {
      success: true,
      collectionId: sessionId,
      scriptCount: candidates.length,
      totalSourceBytes,
      truncated: Boolean(state.truncated) || candidates.length >= maxScripts,
      scripts: candidates.map(({ source, ...script }) => ({ ...script, ...(includeSource && source != null ? { source } : {}) })),
    };
  }

  searchScripts({ collectionId, query, regex = false, caseSensitive = false, maxResults = 100 }) {
    const state = this.state(collectionId);
    const flags = caseSensitive ? "g" : "gi";
    const matcher = regex ? new RegExp(query, flags) : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
    const results = [];
    for (const script of state.scripts.values()) {
      if (!script.source) continue;
      matcher.lastIndex = 0;
      for (const match of script.source.matchAll(matcher)) {
        const line = script.source.slice(0, match.index).split("\n").length;
        const start = Math.max(0, match.index - 120);
        const end = Math.min(script.source.length, match.index + match[0].length + 120);
        results.push({ scriptId: script.scriptId, url: script.url, line, match: match[0], preview: script.source.slice(start, end) });
        if (results.length >= maxResults) return { success: true, collectionId, total: results.length, truncated: true, results };
      }
    }
    return { success: true, collectionId, total: results.length, truncated: false, results };
  }

  extractFunctionTree({ collectionId, functionName, maxDepth = 3 }) {
    const state = this.state(collectionId);
    for (const script of state.scripts.values()) {
      if (!script.source) continue;
      let ast;
      try { ast = parseCode(script.source); } catch { continue; }
      const functions = new Map();
      walk.ancestor(ast, {
        FunctionDeclaration(node) { if (node.id?.name) functions.set(node.id.name, node); },
        VariableDeclarator(node) { if (node.id?.type === "Identifier" && ["FunctionExpression", "ArrowFunctionExpression"].includes(node.init?.type)) functions.set(node.id.name, node.init); },
      });
      if (!functions.has(functionName)) continue;
      const seen = new Set();
      const build = (name, depth) => {
        const node = functions.get(name);
        if (!node || seen.has(name)) return { name, unresolved: !node, recursive: seen.has(name) };
        seen.add(name);
        const calls = new Set();
        walk.simple(node.body || node, { CallExpression(call) { const called = calleeName(call.callee); if (called) calls.add(called); } });
        return {
          name,
          location: { line: node.loc.start.line, column: node.loc.start.column },
          source: script.source.slice(node.start, node.end),
          dependencies: depth < maxDepth ? [...calls].map((called) => build(called, depth + 1)) : [...calls].map((called) => ({ name: called, depthLimit: true })),
        };
      };
      return { success: true, collectionId, scriptId: script.scriptId, url: script.url, tree: build(functionName, 0) };
    }
    throw new Error(`Function not found in collected scripts: ${functionName}`);
  }

  async webpackEnumerate({ sessionId, query = "", maxModules = 500, targetSessionId }) {
    const expression = `(() => {
      const chunkKeys = Object.keys(globalThis).filter(k => /^webpackChunk/.test(k));
      const modules = [];
      for (const key of chunkKeys) {
        const chunk = globalThis[key];
        if (!Array.isArray(chunk) || typeof chunk.push !== 'function') continue;
        let runtime;
        try { chunk.push([[Symbol('cab')], {}, r => { runtime = r; }]); } catch {}
        const table = runtime?.m || {};
        for (const [id, fn] of Object.entries(table)) {
          let source = ''; try { source = Function.prototype.toString.call(fn); } catch {}
          if (!${JSON.stringify(query)} || source.toLowerCase().includes(${JSON.stringify(query.toLowerCase())})) modules.push({ chunk: key, id, source: source.slice(0, 2000) });
          if (modules.length >= ${Math.max(1, Math.min(maxModules, 2_000))}) break;
        }
      }
      return { chunkKeys, modules, truncated: modules.length >= ${Math.max(1, Math.min(maxModules, 2_000))} };
    })()`;
    return { success: true, ...(await this.evaluateGlobal(sessionId, expression, targetSessionId)) };
  }

  async discoverSourceMaps({ sessionId, targetSessionId, waitMs = 200 }) {
    await this.collectCode({ sessionId, targetSessionId, waitMs, includeSource: true, maxScripts: 500, maxSourceBytes: MAX_SCRIPT_SOURCE_BYTES });
    const state = this.state(sessionId);
    const maps = [...state.scripts.values()].filter((script) => script.sourceMapURL).map((script) => ({ scriptId: script.scriptId, scriptUrl: script.url, sourceMapUrl: this.#resolveUrl(script.sourceMapURL, script.url), inline: script.sourceMapURL.startsWith("data:"), targetSessionId: script.targetSessionId }));
    return { success: true, maps };
  }

  #resolveUrl(value, base) {
    try { return new URL(value, base || undefined).href; } catch { return value; }
  }

  async fetchTextInPage(sessionId, url, targetSessionId) {
    if (url.startsWith("data:")) {
      const comma = url.indexOf(",");
      const metadata = url.slice(0, comma);
      const payload = url.slice(comma + 1);
      return metadata.includes(";base64") ? Buffer.from(payload, "base64").toString("utf8") : decodeURIComponent(payload);
    }
    if (typeof url !== "string" || url.length === 0) throw new Error("sourceMapUrl is required when mapText is not supplied");
    const expression = `fetch(${JSON.stringify(url)}, { credentials: 'include' }).then(async r => { const text = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status); if (new TextEncoder().encode(text).byteLength > 8000000) throw new Error('Source map exceeds 8000000 bytes'); return text; })`;
    const result = await this.send(sessionId, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, targetSessionId, { timeoutMs: 60_000 });
    if (result?.exceptionDetails) throw new Error(result.exceptionDetails.text || "Page fetch failed");
    return result?.result?.value || "";
  }

  async debuggerLifecycle({ sessionId, action, targetSessionId }) {
    const method = action === "disable" ? "Debugger.disable" : "Debugger.enable";
    const result = await this.send(sessionId, method, {}, targetSessionId);
    if (action !== "disable") await this.send(sessionId, "Runtime.enable", {}, targetSessionId);
    return { success: true, action, result };
  }

  async debuggerControl({ sessionId, action, targetSessionId }) {
    const methods = { pause: "Debugger.pause", resume: "Debugger.resume", into: "Debugger.stepInto", over: "Debugger.stepOver", out: "Debugger.stepOut" };
    const method = methods[action];
    if (!method) throw new Error(`Unsupported debugger action: ${action}`);
    const result = await this.send(sessionId, method, {}, targetSessionId);
    return { success: true, action, result };
  }

  async runToLocation({ sessionId, scriptId, lineNumber, columnNumber = 0, targetSessionId }) {
    const set = await this.send(sessionId, "Debugger.setBreakpoint", { location: { scriptId, lineNumber, columnNumber } }, targetSessionId);
    await this.send(sessionId, "Debugger.resume", {}, targetSessionId);
    return { success: true, breakpointId: set.breakpointId, actualLocation: set.actualLocation };
  }

  async breakpoint(input) {
    const { sessionId, action, targetSessionId } = input;
    const state = this.state(sessionId);
    if (action === "list") return { success: true, breakpoints: [...state.breakpoints.values()] };
    if (action === "remove") {
      await this.send(sessionId, "Debugger.removeBreakpoint", { breakpointId: input.breakpointId }, targetSessionId);
      state.breakpoints.delete(input.breakpointId);
      return { success: true, removed: input.breakpointId };
    }
    if (action === "exceptions") {
      await this.send(sessionId, "Debugger.setPauseOnExceptions", { state: input.state || "all" }, targetSessionId);
      return { success: true, state: input.state || "all" };
    }
    if (action === "xhr") {
      const method = input.remove ? "DOMDebugger.removeXHRBreakpoint" : "DOMDebugger.setXHRBreakpoint";
      await this.send(sessionId, method, { url: input.url || "" }, targetSessionId);
      return { success: true, action, url: input.url || "", removed: Boolean(input.remove) };
    }
    if (action === "event") {
      const method = input.remove ? "DOMDebugger.removeEventListenerBreakpoint" : "DOMDebugger.setEventListenerBreakpoint";
      await this.send(sessionId, method, { eventName: input.eventName, ...(input.targetName ? { targetName: input.targetName } : {}) }, targetSessionId);
      return { success: true, action, eventName: input.eventName, removed: Boolean(input.remove) };
    }
    let result;
    if (input.urlRegex || input.url) {
      result = await this.send(sessionId, "Debugger.setBreakpointByUrl", { lineNumber: input.lineNumber || 0, columnNumber: input.columnNumber || 0, ...(input.urlRegex ? { urlRegex: input.urlRegex } : { url: input.url }), ...(input.condition ? { condition: input.condition } : {}) }, targetSessionId);
    } else {
      result = await this.send(sessionId, "Debugger.setBreakpoint", { location: { scriptId: input.scriptId, lineNumber: input.lineNumber || 0, columnNumber: input.columnNumber || 0 }, ...(input.condition ? { condition: input.condition } : {}) }, targetSessionId);
    }
    const item = { breakpointId: result.breakpointId, locations: result.locations || [result.actualLocation].filter(Boolean), input };
    state.breakpoints.set(item.breakpointId, item);
    return { success: true, ...item };
  }

  async waitForPaused({ sessionId, timeoutMs = 10_000, targetSessionId }) {
    const state = this.state(sessionId);
    const current = () => targetSessionId ? state.pausedByTarget.get(targetKey(targetSessionId)) : state.paused;
    if (current()) return { success: true, paused: current() };
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      await this.poll(sessionId, { timeoutMs: Math.min(25_000, Math.max(0, deadline - Date.now())) });
      if (current()) return { success: true, paused: current() };
      if (Date.now() >= deadline) break;
    }
    return { success: true, paused: null, timedOut: true };
  }

  getPausedState(sessionId, targetSessionId) {
    const state = this.state(sessionId);
    return { success: true, paused: targetSessionId ? state.pausedByTarget.get(targetKey(targetSessionId)) || null : state.paused, cursor: state.cursor };
  }

  getCallStack(sessionId, targetSessionId) {
    const state = this.state(sessionId);
    const paused = targetSessionId ? state.pausedByTarget.get(targetKey(targetSessionId)) : state.paused;
    if (!paused) throw new Error("Debugger is not paused");
    return { success: true, reason: paused.reason, hitBreakpoints: paused.hitBreakpoints || [], callFrames: paused.callFrames || [], asyncStackTrace: paused.asyncStackTrace || null };
  }

  async debuggerEvaluate({ sessionId, expression, callFrameId, awaitPromise = true, returnByValue = true, targetSessionId }) {
    const method = callFrameId ? "Debugger.evaluateOnCallFrame" : "Runtime.evaluate";
    const params = callFrameId ? { callFrameId, expression, returnByValue, awaitPromise, throwOnSideEffect: false } : { expression, returnByValue, awaitPromise };
    const result = await this.send(sessionId, method, params, targetSessionId);
    return { success: !result.exceptionDetails, value: stringifyRemote(result.result), remoteObject: result.result, exceptionDetails: result.exceptionDetails || null };
  }

  async evaluateGlobal(sessionId, expression, targetSessionId) {
    return this.debuggerEvaluate({ sessionId, expression, targetSessionId, awaitPromise: true, returnByValue: true });
  }

  async objectProperties({ sessionId, objectId, ownProperties = true, accessorPropertiesOnly = false, generatePreview = true, targetSessionId }) {
    const result = await this.send(sessionId, "Runtime.getProperties", { objectId, ownProperties, accessorPropertiesOnly, generatePreview }, targetSessionId);
    return { success: true, ...result };
  }

  async enhancedScope({ sessionId, objectId, depth = 2, maxProperties = 200, targetSessionId }) {
    const seen = new Set();
    const read = async (id, level) => {
      if (!id || seen.has(id) || level > depth) return null;
      seen.add(id);
      const result = await this.send(sessionId, "Runtime.getProperties", { objectId: id, ownProperties: true, generatePreview: true }, targetSessionId);
      const properties = [];
      for (const property of (result.result || []).slice(0, maxProperties)) {
        const item = { name: property.name, value: stringifyRemote(property.value), type: property.value?.type, description: property.value?.description };
        if (property.value?.objectId && level < depth) item.children = await read(property.value.objectId, level + 1);
        properties.push(item);
      }
      return properties;
    };
    return { success: true, objectId, properties: await read(objectId, 0) };
  }

  async captureHit(input) {
    const waited = await this.waitForPaused(input);
    if (!waited.paused) return waited;
    const top = waited.paused.callFrames?.[0];
    const scopes = [];
    if (input.includeScopes && top) {
      for (const scope of top.scopeChain || []) {
        const objectId = scope.object?.objectId;
        scopes.push({ type: scope.type, name: scope.name, ...(objectId ? { variables: (await this.enhancedScope({ sessionId: input.sessionId, objectId, depth: input.scopeDepth || 1, targetSessionId: input.targetSessionId })).properties } : {}) });
      }
    }
    return { success: true, paused: waited.paused, topFrameScopes: scopes };
  }

  async debuggerDisassemble({ sessionId, scriptId, callFrameId, includeSourceFallback = true, targetSessionId }) {
    let resolvedScriptId = scriptId;
    if (!resolvedScriptId && callFrameId) resolvedScriptId = this.state(sessionId).paused?.callFrames?.find((frame) => frame.callFrameId === callFrameId)?.location?.scriptId;
    if (!resolvedScriptId) resolvedScriptId = this.state(sessionId).paused?.callFrames?.[0]?.location?.scriptId;
    if (!resolvedScriptId) throw new Error("scriptId is required when no paused frame is available");
    try {
      const result = await this.send(sessionId, "Debugger.disassembleWasmModule", { scriptId: resolvedScriptId }, targetSessionId);
      return { success: true, scriptId: resolvedScriptId, native: true, ...result };
    } catch (error) {
      if (!includeSourceFallback) throw error;
      const source = await this.send(sessionId, "Debugger.getScriptSource", { scriptId: resolvedScriptId }, targetSessionId);
      return { success: true, scriptId: resolvedScriptId, native: false, fallback: "source-lines", lines: String(source.scriptSource || "").split("\n").slice(0, 2_000).map((text, index) => ({ offset: index + 1, text })) };
    }
  }

  async watch(input) {
    const state = this.state(input.sessionId);
    if (input.action === "add") {
      const id = `watch_${randomUUID()}`;
      state.watches.set(id, { id, expression: input.expression });
      return { success: true, watch: state.watches.get(id) };
    }
    if (input.action === "remove") return { success: true, removed: state.watches.delete(input.watchId) };
    if (input.action === "clear") { state.watches.clear(); return { success: true, cleared: true }; }
    const values = [];
    for (const item of state.watches.values()) values.push({ ...item, evaluation: await this.debuggerEvaluate({ sessionId: input.sessionId, expression: item.expression, callFrameId: input.callFrameId, targetSessionId: input.targetSessionId }) });
    return { success: true, watches: values };
  }

  async blackbox(input) {
    const state = this.state(input.sessionId);
    if (input.action === "add") state.blackboxPatterns.push(...input.patterns);
    if (input.action === "common") state.blackboxPatterns.push("node_modules", "webpack/bootstrap", "react(?:-dom)?", "vue(?:\.runtime)?", "angular", "zone\\.js");
    if (input.action === "clear") state.blackboxPatterns = [];
    state.blackboxPatterns = [...new Set(state.blackboxPatterns)];
    if (input.action !== "list") await this.send(input.sessionId, "Debugger.setBlackboxPatterns", { patterns: state.blackboxPatterns }, input.targetSessionId);
    return { success: true, patterns: state.blackboxPatterns };
  }

  async debuggerSession(input) {
    const state = this.state(input.sessionId);
    if (input.action === "list") return { success: true, sessions: [...state.savedSessions.entries()].map(([name, snapshot]) => ({ name, savedAt: snapshot.savedAt })) };
    if (input.action === "save") {
      const name = input.name || `session-${state.savedSessions.size + 1}`;
      state.savedSessions.set(name, { savedAt: new Date().toISOString(), state: snapshotState(state) });
      return { success: true, name };
    }
    if (input.action === "export") return { success: true, name: input.name, snapshot: input.name ? state.savedSessions.get(input.name) : { savedAt: new Date().toISOString(), state: snapshotState(state) } };
    if (input.action === "load") {
      const saved = state.savedSessions.get(input.name);
      if (!saved) throw new Error(`Unknown saved debugger session: ${input.name}`);
      state.watches = new Map(saved.state.watches);
      state.blackboxPatterns = [...saved.state.blackboxPatterns];
      await this.send(input.sessionId, "Debugger.setBlackboxPatterns", { patterns: state.blackboxPatterns }, input.targetSessionId);
      return { success: true, name: input.name, restored: { watches: state.watches.size, blackboxPatterns: state.blackboxPatterns.length }, boundary: "Breakpoints are exported as metadata and are not silently recreated." };
    }
    throw new Error(`Unsupported debugger session action: ${input.action}`);
  }

  async performanceMetrics({ sessionId, targetSessionId }) {
    await this.send(sessionId, "Performance.enable", {}, targetSessionId);
    const result = await this.send(sessionId, "Performance.getMetrics", {}, targetSessionId);
    return { success: true, metrics: Object.fromEntries((result.metrics || []).map((item) => [item.name, item.value])) };
  }

  async coverage(input) {
    if (input.action === "start") {
      await this.send(input.sessionId, "Profiler.enable", {}, input.targetSessionId);
      await this.send(input.sessionId, "Profiler.startPreciseCoverage", { callCount: true, detailed: true, allowTriggeredUpdates: false }, input.targetSessionId);
      if (input.includeCss) await this.send(input.sessionId, "CSS.startRuleUsageTracking", {}, input.targetSessionId);
      return { success: true, state: "running" };
    }
    const js = await this.send(input.sessionId, "Profiler.takePreciseCoverage", {}, input.targetSessionId);
    await this.send(input.sessionId, "Profiler.stopPreciseCoverage", {}, input.targetSessionId);
    let css = null;
    if (input.includeCss) css = await this.send(input.sessionId, "CSS.stopRuleUsageTracking", {}, input.targetSessionId);
    return { success: true, state: "stopped", javascript: js.result || [], css: css?.ruleUsage || [] };
  }

  async cpuProfiler(input) {
    if (input.action === "start") {
      await this.send(input.sessionId, "Profiler.enable", {}, input.targetSessionId);
      await this.send(input.sessionId, "Profiler.start", {}, input.targetSessionId);
      return { success: true, state: "running" };
    }
    const result = await this.send(input.sessionId, "Profiler.stop", {}, input.targetSessionId, { timeoutMs: 60_000 });
    const nodes = result.profile?.nodes || [];
    const hits = new Map(nodes.map((node) => [node.id, { functionName: node.callFrame?.functionName || "", url: node.callFrame?.url || "", hitCount: node.hitCount || 0 }]));
    return { success: true, state: "stopped", profile: result.profile, hotspots: [...hits.values()].sort((a, b) => b.hitCount - a.hitCount).slice(0, 100) };
  }

  async heapSampling(input) {
    if (input.action === "start") {
      await this.send(input.sessionId, "HeapProfiler.enable", {}, input.targetSessionId);
      await this.send(input.sessionId, "HeapProfiler.startSampling", { samplingInterval: input.samplingInterval || 32_768 }, input.targetSessionId);
      return { success: true, state: "running" };
    }
    const result = await this.send(input.sessionId, "HeapProfiler.stopSampling", {}, input.targetSessionId, { timeoutMs: 60_000 });
    return { success: true, state: "stopped", profile: result.profile };
  }

  async heapSnapshot(input) {
    const state = this.state(input.sessionId);
    if (state.heapSnapshot) throw new Error("A heap snapshot is already active for this Raw session");
    const capture = { chunks: [], bytes: 0, startedCursor: state.cursor, startedDropped: state.dropped, targetKey: targetKey(input.targetSessionId), overflow: false };
    state.heapSnapshot = capture;
    try {
      await this.send(input.sessionId, "HeapProfiler.enable", {}, input.targetSessionId);
      await this.send(input.sessionId, "HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: Boolean(input.captureNumericValue) }, input.targetSessionId, { timeoutMs: 120_000 });
      await this.poll(input.sessionId, { timeoutMs: 1_000 });
      if (capture.overflow || state.dropped > capture.startedDropped) {
        const error = new Error("Heap snapshot exceeded the Raw event buffer; retry with a larger Raw maxBytes when supported or use DevTools for a full snapshot");
        error.code = "artifact_truncated";
        throw error;
      }
      const content = capture.chunks.join("");
      const artifactPath = await this.#writeArtifact("heap-snapshots", "heapsnapshot", content);
      return { success: true, artifactPath, bytes: Buffer.byteLength(content), chunkCount: capture.chunks.length };
    } finally {
      state.heapSnapshot = null;
    }
  }

  async trace(input) {
    const state = this.state(input.sessionId);
    if (input.action === "start") {
      if (state.trace) throw new Error("A performance trace is already active for this Raw session");
      state.trace = { events: [], bytes: 0, complete: false, startedCursor: state.cursor, startedDropped: state.dropped, targetKey: targetKey(input.targetSessionId), overflow: false };
      try {
        await this.send(input.sessionId, "Tracing.start", { transferMode: "ReportEvents", categories: input.categories?.join(",") || "devtools.timeline,v8.execute,blink.user_timing" }, input.targetSessionId);
        return { success: true, state: "running" };
      } catch (error) {
        state.trace = null;
        throw error;
      }
    }
    if (!state.trace) throw new Error("No active trace exists for this Raw session");
    const capture = state.trace;
    try {
      await this.send(input.sessionId, "Tracing.end", {}, input.targetSessionId);
      const deadline = Date.now() + (input.timeoutMs || 10_000);
      while (!capture.complete && Date.now() < deadline) await this.poll(input.sessionId, { timeoutMs: Math.min(1_000, deadline - Date.now()) });
      if (capture.overflow || state.dropped > capture.startedDropped) throw Object.assign(new Error("Trace events were truncated by the Raw event buffer or artifact limit"), { code: "artifact_truncated" });
      if (!capture.complete) throw Object.assign(new Error("Tracing.tracingComplete was not observed before timeout"), { code: "artifact_incomplete" });
      const content = JSON.stringify({ traceEvents: capture.events });
      const artifactPath = await this.#writeArtifact("traces", "json", content);
      return { success: true, state: "stopped", complete: capture.complete, eventCount: capture.events.length, artifactPath, bytes: Buffer.byteLength(content) };
    } finally {
      state.trace = null;
    }
  }

  async exceptions(input) {
    const state = this.state(input.sessionId);
    await this.send(input.sessionId, "Runtime.enable", {}, input.targetSessionId);
    await this.poll(input.sessionId, { timeoutMs: input.timeoutMs || 0 });
    const exceptions = state.exceptions.splice(0, input.clear === false ? 0 : state.exceptions.length);
    return { success: true, exceptions: input.clear === false ? [...state.exceptions] : exceptions, cursor: state.cursor };
  }

  async networkBody({ sessionId, requestId, targetSessionId }) {
    const result = await this.send(sessionId, "Network.getResponseBody", { requestId }, targetSessionId);
    return { success: true, requestId, base64Encoded: Boolean(result.base64Encoded), body: result.body || "", bytes: result.base64Encoded ? Buffer.from(result.body || "", "base64").length : Buffer.byteLength(result.body || "") };
  }

  async networkStats(input) {
    const state = this.state(input.sessionId);
    await this.send(input.sessionId, "Network.enable", {}, input.targetSessionId);
    await this.poll(input.sessionId, { timeoutMs: input.timeoutMs || 0 });
    const activeRequests = [...state.requests.values()].filter((request) => !input.targetSessionId || request.targetSessionId === input.targetSessionId);
    const requests = [...state.completedRequests, ...activeRequests].filter((request) => !input.targetSessionId || request.targetSessionId === input.targetSessionId);
    const byType = {};
    const byStatus = {};
    for (const request of requests) {
      byType[request.resourceType || "Other"] = (byType[request.resourceType || "Other"] || 0) + 1;
      if (request.status) byStatus[String(request.status)] = (byStatus[String(request.status)] || 0) + 1;
    }
    const completed = state.completedRequests.filter((request) => !input.targetSessionId || request.targetSessionId === input.targetSessionId);
    return {
      success: true,
      total: requests.length,
      active: activeRequests.length,
      completed: completed.length,
      failed: completed.filter((request) => request.failed).length,
      bytes: completed.reduce((sum, request) => sum + (request.encodedDataLength || 0), 0),
      averageDurationMs: completed.length ? Number((completed.reduce((sum, request) => sum + (request.durationMs || 0), 0) / completed.length).toFixed(3)) : null,
      byType,
      byStatus,
      truncated: Boolean(state.truncated),
    };
  }

  async exportHar(input) {
    const state = this.state(input.sessionId);
    await this.poll(input.sessionId, { timeoutMs: input.timeoutMs || 0 });
    const entries = [...state.completedRequests, ...state.requests.values()].filter((request) => !input.targetSessionId || request.targetSessionId === input.targetSessionId).map((request) => ({
      startedDateTime: request.wallTime ? new Date(request.wallTime * 1_000).toISOString() : new Date().toISOString(),
      time: request.durationMs || 0,
      request: { method: request.method || "GET", url: request.url || "", httpVersion: request.protocol || "", headers: harHeaders(request.requestHeaders), queryString: (() => { try { return [...new URL(request.url).searchParams].map(([name, value]) => ({ name, value })); } catch { return []; } })(), cookies: [], headersSize: -1, bodySize: request.postData ? Buffer.byteLength(request.postData) : 0, ...(request.postData ? { postData: { mimeType: normalizeHeaders(request.requestHeaders).find((item) => item.name.toLowerCase() === "content-type")?.value || "", text: request.postData } } : {}) },
      response: { status: request.status || 0, statusText: request.statusText || "", httpVersion: request.protocol || "", headers: harHeaders(request.responseHeaders), cookies: [], content: { size: request.encodedDataLength || 0, mimeType: request.mimeType || "" }, redirectURL: "", headersSize: -1, bodySize: request.encodedDataLength || 0 },
      cache: {}, timings: { send: 0, wait: request.durationMs || 0, receive: 0 },
      _requestId: request.requestId,
      _failed: Boolean(request.failed),
    }));
    const har = { log: { version: "1.2", creator: { name: "chrome-agent-bridge", version: "0.8.0" }, entries } };
    const content = JSON.stringify(har, null, 2);
    const artifactPath = await this.#writeArtifact("network", "har", content);
    return { success: true, entryCount: entries.length, artifactPath, bytes: Buffer.byteLength(content), containsSensitiveData: true };
  }

  async extractAuth(input) {
    if (input.confirmed !== true) {
      const error = new Error("confirmed=true is required because authentication extraction returns secrets");
      error.code = "confirmation_required";
      throw error;
    }
    const state = this.state(input.sessionId);
    await this.poll(input.sessionId, { timeoutMs: input.timeoutMs || 0 });
    const findings = [];
    for (const request of [...state.completedRequests, ...state.requests.values()].filter((request) => !input.targetSessionId || request.targetSessionId === input.targetSessionId)) {
      for (const header of normalizeHeaders(request.requestHeaders)) if (SENSITIVE_HEADER.test(header.name)) findings.push({ requestId: request.requestId, url: request.url, location: "request-header", name: header.name, value: header.value });
      for (const header of normalizeHeaders(request.responseHeaders)) if (SENSITIVE_HEADER.test(header.name)) findings.push({ requestId: request.requestId, url: request.url, location: "response-header", name: header.name, value: header.value });
      for (const cookie of request.associatedCookies || []) findings.push({ requestId: request.requestId, url: request.url, location: "associated-cookie", name: cookie.cookie?.name, value: cookie.cookie?.value, blockedReasons: cookie.blockedReasons });
    }
    return { success: true, findingCount: findings.length, findings, containsSecrets: true };
  }

  async intercept(input) {
    const state = this.state(input.sessionId);
    if (input.action === "enable") {
      state.intercept = { enabled: true, patterns: input.patterns || [], paused: [] };
      await this.send(input.sessionId, "Fetch.enable", { patterns: state.intercept.patterns, handleAuthRequests: Boolean(input.handleAuthRequests) }, input.targetSessionId);
      return { success: true, enabled: true, patterns: state.intercept.patterns };
    }
    if (input.action === "disable") {
      await this.send(input.sessionId, "Fetch.disable", {}, input.targetSessionId);
      state.intercept = { enabled: false, patterns: [], paused: [] };
      return { success: true, enabled: false };
    }
    if (input.action === "list") return { success: true, ...state.intercept };
    if (input.action === "poll") {
      await this.poll(input.sessionId, { timeoutMs: input.timeoutMs || 0 });
      return { success: true, requests: [...state.intercept.paused] };
    }
    const requestId = input.requestId;
    if (!requestId) throw new Error("requestId is required");
    const methods = { continue: ["Fetch.continueRequest", {}], fail: ["Fetch.failRequest", { errorReason: input.errorReason || "Failed" }], fulfill: ["Fetch.fulfillRequest", { responseCode: input.responseCode || 200, responseHeaders: input.responseHeaders || [], ...(input.bodyBase64 ? { body: input.bodyBase64 } : {}) }] };
    const selected = methods[input.action];
    if (!selected) throw new Error(`Unsupported intercept action: ${input.action}`);
    await this.send(input.sessionId, selected[0], { requestId, ...selected[1], ...(input.action === "continue" ? { ...(input.url ? { url: input.url } : {}), ...(input.method ? { method: input.method } : {}), ...(input.postDataBase64 ? { postData: input.postDataBase64 } : {}), ...(input.headers ? { headers: input.headers } : {}) } : {}) }, input.targetSessionId);
    state.intercept.paused = state.intercept.paused.filter((request) => request.requestId !== requestId || targetKey(request.targetSessionId) !== targetKey(input.targetSessionId));
    return { success: true, action: input.action, requestId };
  }

  async #writeArtifact(category, extension, content) {
    const directory = path.join(bridgeDirectory(), "artifacts", category);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.${extension}`);
    await fs.writeFile(file, content, { mode: 0o600 });
    return file;
  }
}
