import { z } from "zod";
import { CdpAnalysisManager } from "../lib/cdp-analysis.mjs";
import { SourceMapEngine } from "../lib/source-map-analysis.mjs";

const cdp = new CdpAnalysisManager();
const sourceMaps = new SourceMapEngine();
const sessionId = z.string().min(20).max(120);
const targetSessionId = z.string().min(1).max(200).optional();
const timeoutMs = z.number().int().min(0).max(25_000).optional().default(0);

export function clearCdpAnalysisSession(sessionIdValue) {
  return cdp.clearSession(sessionIdValue);
}

function requireConfirmed(input, message) {
  if (input.confirmed === true) return;
  const error = new Error(message);
  error.code = "confirmation_required";
  throw error;
}

export function registerCdpAnalysisTools({ tool, asText }) {
  tool("collect_code", {
    title: "Collect page JavaScript",
    description: "Enable Debugger on an existing Raw session, collect script metadata, and optionally fetch bounded script sources into the local MCP process.",
    inputSchema: { sessionId, targetSessionId, waitMs: z.number().int().min(0).max(25_000).optional().default(250), includeSource: z.boolean().optional().default(true), maxScripts: z.number().int().min(1).max(1_000).optional().default(100), maxSourceBytes: z.number().int().min(1_024).max(3_000_000).optional().default(3_000_000), urlIncludes: z.array(z.string().max(500)).max(50).optional().default([]) },
  }, async (input) => asText(await cdp.collectCode(input)));

  tool("search_in_scripts", {
    title: "Search collected scripts",
    description: "Search script sources already collected in this MCP process by literal text or regular expression.",
    inputSchema: { collectionId: sessionId, query: z.string().min(1).max(2_000), regex: z.boolean().optional().default(false), caseSensitive: z.boolean().optional().default(false), maxResults: z.number().int().min(1).max(1_000).optional().default(100) },
  }, async (input) => asText(cdp.searchScripts(input)));

  tool("extract_function_tree", {
    title: "Extract function dependency tree",
    description: "Find a named function in collected scripts and recursively project statically named call dependencies.",
    inputSchema: { collectionId: sessionId, functionName: z.string().min(1).max(500), maxDepth: z.number().int().min(0).max(10).optional().default(3) },
  }, async (input) => asText(cdp.extractFunctionTree(input)));

  tool("webpack_enumerate", {
    title: "Enumerate Webpack modules",
    description: "Evaluate a bounded Webpack module-table collector in the selected Raw target. This modifies the chunk array only by appending a runtime probe.",
    inputSchema: { sessionId, targetSessionId, query: z.string().max(1_000).optional().default(""), maxModules: z.number().int().min(1).max(2_000).optional().default(500) },
  }, async (input) => asText(await cdp.webpackEnumerate(input)));

  tool("sourcemap_discover", {
    title: "Discover source maps",
    description: "Discover sourceMappingURL values from Debugger.scriptParsed events and collected script tails.",
    inputSchema: { sessionId, targetSessionId, waitMs: z.number().int().min(0).max(25_000).optional().default(200) },
  }, async (input) => asText(await cdp.discoverSourceMaps(input)));

  tool("sourcemap_fetch_and_parse", {
    title: "Fetch and parse source map",
    description: "Parse supplied source-map JSON, or fetch a map through the selected page's authenticated fetch context before parsing it locally.",
    inputSchema: { sourceMapUrl: z.string().max(20_000).optional(), mapText: z.string().max(8_000_000).optional(), sessionId: sessionId.optional(), targetSessionId, scriptUrl: z.string().max(20_000).optional() },
  }, async (input) => {
    if (input.mapText == null && (!input.sourceMapUrl || !input.sessionId)) throw new Error("Provide mapText, or provide sourceMapUrl together with sessionId");
    if (input.mapText != null && input.sourceMapUrl && input.sessionId) throw new Error("Provide either mapText or sourceMapUrl+sessionId, not both fetch modes");
    const mapText = input.mapText ?? await cdp.fetchTextInPage(input.sessionId, input.sourceMapUrl, input.targetSessionId);
    return asText(sourceMaps.parse(mapText, { mapUrl: input.sourceMapUrl, scriptUrl: input.scriptUrl }));
  });

  tool("sourcemap_coverage", {
    title: "Summarize source-map coverage",
    description: "Summarize mapped original lines and sources for a parsed source map.",
    inputSchema: { mapId: z.string().min(10).max(120) },
  }, async (input) => asText(sourceMaps.coverage(input.mapId)));

  tool("sourcemap_lookup", {
    title: "Look up original source position",
    description: "Map a one-based generated line and zero-based column back to an original source position.",
    inputSchema: { mapId: z.string().min(10).max(120), line: z.number().int().min(1), column: z.number().int().min(0).optional().default(0) },
  }, async (input) => asText(sourceMaps.lookup(input.mapId, input.line, input.column)));

  tool("sourcemap_reconstruct_tree", {
    title: "Reconstruct source tree",
    description: "Reconstruct safe relative source paths and optionally return bounded sourcesContent from a parsed source map.",
    inputSchema: { mapId: z.string().min(10).max(120), includeContents: z.boolean().optional().default(false), maxFiles: z.number().int().min(1).max(2_000).optional().default(500) },
  }, async (input) => asText(sourceMaps.reconstruct(input.mapId, input)));

  tool("sourcemap_parse_v4", {
    title: "Parse v4-compatible source map",
    description: "Parse compatible mappings and preserve ECMA-426 debug ID and scope-field metadata.",
    inputSchema: { mapText: z.string().min(2).max(8_000_000), mapUrl: z.string().max(20_000).optional() },
  }, async (input) => asText(sourceMaps.parseV4(input.mapText, input)));

  tool("sourcemap_diff", {
    title: "Diff source maps",
    description: "Compare source membership and sourcesContent hashes between two locally parsed source maps.",
    inputSchema: { mapIdA: z.string().min(10).max(120), mapIdB: z.string().min(10).max(120), lineThreshold: z.number().int().min(0).max(100_000).optional().default(1) },
  }, async (input) => asText(sourceMaps.diff(input.mapIdA, input.mapIdB, input)));

  tool("debugger_lifecycle", {
    title: "Manage debugger lifecycle",
    description: "Enable or disable the Debugger domain on an existing Raw CDP session.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["enable", "disable"]) },
  }, async (input) => asText(await cdp.debuggerLifecycle(input)));

  tool("debugger_pause", {
    title: "Pause debugger",
    description: "Request a pause at the next JavaScript statement.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(await cdp.debuggerControl({ ...input, action: "pause" })));

  tool("debugger_resume", {
    title: "Resume debugger",
    description: "Resume a paused JavaScript debugger.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(await cdp.debuggerControl({ ...input, action: "resume" })));

  tool("debugger_run_to_location", {
    title: "Run to source location",
    description: "Set a breakpoint at a script location and resume execution.",
    inputSchema: { sessionId, targetSessionId, scriptId: z.string().min(1).max(200), lineNumber: z.number().int().nonnegative(), columnNumber: z.number().int().nonnegative().optional().default(0) },
  }, async (input) => asText(await cdp.runToLocation(input)));

  tool("debugger_step", {
    title: "Step debugger",
    description: "Step into, over, or out from a paused JavaScript frame.",
    inputSchema: { sessionId, targetSessionId, direction: z.enum(["into", "over", "out"]) },
  }, async (input) => asText(await cdp.debuggerControl({ ...input, action: input.direction })));

  tool("breakpoint", {
    title: "Manage debugger breakpoints",
    description: "Add, remove, or list source breakpoints and manage exception, XHR, or event-listener breakpoints.",
    inputSchema: {
      sessionId,
      targetSessionId,
      action: z.enum(["add", "remove", "list", "exceptions", "xhr", "event"]),
      breakpointId: z.string().max(500).optional(),
      scriptId: z.string().max(200).optional(),
      url: z.string().max(20_000).optional(),
      urlRegex: z.string().max(2_000).optional(),
      lineNumber: z.number().int().nonnegative().optional(),
      columnNumber: z.number().int().nonnegative().optional(),
      condition: z.string().max(10_000).optional(),
      state: z.enum(["none", "uncaught", "caught", "all"]).optional(),
      eventName: z.string().max(300).optional(),
      targetName: z.string().max(300).optional(),
      remove: z.boolean().optional().default(false),
    },
  }, async (input) => {
    if (input.action === "add" && !input.scriptId && !input.url && !input.urlRegex) throw new Error("add requires scriptId, url, or urlRegex");
    if (input.action === "remove" && !input.breakpointId) throw new Error("remove requires breakpointId");
    if (input.action === "xhr" && input.url == null) throw new Error("xhr requires url, which may be an empty string");
    if (input.action === "event" && !input.eventName) throw new Error("event requires eventName");
    return asText(await cdp.breakpoint(input));
  });

  tool("get_call_stack", {
    title: "Get debugger call stack",
    description: "Return the most recently captured Debugger.paused call stack for a Raw session.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(cdp.getCallStack(input.sessionId, input.targetSessionId)));

  tool("debugger_disassemble", {
    title: "Disassemble debugger script",
    description: "Try CDP WASM disassembly for a script and fall back to bounded source-line projection.",
    inputSchema: { sessionId, targetSessionId, scriptId: z.string().max(200).optional(), callFrameId: z.string().max(500).optional(), includeSourceFallback: z.boolean().optional().default(true) },
  }, async (input) => asText(await cdp.debuggerDisassemble(input)));

  tool("debugger_evaluate", {
    title: "Evaluate in debugger",
    description: "Evaluate an expression globally or on one paused call frame. This executes code in the selected page target.",
    inputSchema: { sessionId, targetSessionId, expression: z.string().min(1).max(200_000), callFrameId: z.string().max(500).optional(), awaitPromise: z.boolean().optional().default(true), returnByValue: z.boolean().optional().default(true) },
  }, async (input) => asText(await cdp.debuggerEvaluate(input)));

  tool("debugger_wait_for_paused", {
    title: "Wait for debugger pause",
    description: "Poll Raw CDP events until Debugger.paused is observed or timeout expires.",
    inputSchema: { sessionId, targetSessionId, timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000) },
  }, async (input) => asText(await cdp.waitForPaused(input)));

  tool("debugger_capture_hit", {
    title: "Capture debugger hit",
    description: "Wait for a pause and capture the call stack plus optional bounded top-frame scope variables.",
    inputSchema: { sessionId, targetSessionId, timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000), includeScopes: z.boolean().optional().default(true), scopeDepth: z.number().int().min(0).max(5).optional().default(1) },
  }, async (input) => asText(await cdp.captureHit(input)));

  tool("debugger_get_paused_state", {
    title: "Get paused debugger state",
    description: "Return the locally cached pause reason and frames without waiting for new events.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(cdp.getPausedState(input.sessionId, input.targetSessionId)));

  tool("get_object_properties", {
    title: "Get remote object properties",
    description: "Read properties for a Runtime remote object ID in the selected Raw target.",
    inputSchema: { sessionId, targetSessionId, objectId: z.string().min(1).max(1_000), ownProperties: z.boolean().optional().default(true), accessorPropertiesOnly: z.boolean().optional().default(false), generatePreview: z.boolean().optional().default(true) },
  }, async (input) => asText(await cdp.objectProperties(input)));

  tool("get_scope_variables_enhanced", {
    title: "Expand scope variables",
    description: "Recursively expand a bounded Runtime object graph from an object ID.",
    inputSchema: { sessionId, targetSessionId, objectId: z.string().min(1).max(1_000), depth: z.number().int().min(0).max(5).optional().default(2), maxProperties: z.number().int().min(1).max(1_000).optional().default(200) },
  }, async (input) => asText(await cdp.enhancedScope(input)));

  tool("debugger_session", {
    title: "Manage debugger session metadata",
    description: "Save, list, load, or export in-memory debugger metadata for one Raw session. Loading never silently recreates breakpoints.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["save", "load", "list", "export"]), name: z.string().min(1).max(120).optional() },
  }, async (input) => asText(await cdp.debuggerSession(input)));

  tool("watch", {
    title: "Manage debugger watches",
    description: "Add, remove, clear, list, and evaluate watch expressions on a global or paused frame.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["add", "remove", "clear", "list", "evaluate"]), expression: z.string().max(100_000).optional(), watchId: z.string().max(200).optional(), callFrameId: z.string().max(500).optional() },
  }, async (input) => {
    if (input.action === "add" && !input.expression) throw new Error("add requires expression");
    if (input.action === "remove" && !input.watchId) throw new Error("remove requires watchId");
    return asText(await cdp.watch(input));
  });

  tool("blackbox_add", {
    title: "Add debugger blackbox patterns",
    description: "Append regular-expression patterns and update Debugger.setBlackboxPatterns.",
    inputSchema: { sessionId, targetSessionId, patterns: z.array(z.string().min(1).max(1_000)).min(1).max(100) },
  }, async (input) => asText(await cdp.blackbox({ ...input, action: "add" })));

  tool("blackbox_add_common", {
    title: "Add common debugger blackboxes",
    description: "Blackbox common framework and dependency script patterns.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(await cdp.blackbox({ ...input, action: "common" })));

  tool("blackbox_list", {
    title: "List debugger blackboxes",
    description: "List blackbox patterns maintained for a Raw session.",
    inputSchema: { sessionId },
  }, async (input) => asText(await cdp.blackbox({ ...input, action: "list" })));

  tool("performance_get_metrics", {
    title: "Get page performance metrics",
    description: "Return the selected target's CDP Performance.getMetrics values.",
    inputSchema: { sessionId, targetSessionId },
  }, async (input) => asText(await cdp.performanceMetrics(input)));

  tool("performance_coverage", {
    title: "Record code coverage",
    description: "Start or stop precise JavaScript coverage and optional CSS rule usage tracking.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["start", "stop"]), includeCss: z.boolean().optional().default(false) },
  }, async (input) => asText(await cdp.coverage(input)));

  tool("performance_take_heap_snapshot", {
    title: "Take bounded heap snapshot",
    description: "Capture HeapProfiler snapshot chunks from Raw events and write a private local artifact. Fails rather than returning an incomplete snapshot when the Raw buffer truncates.",
    inputSchema: { sessionId, targetSessionId, captureNumericValue: z.boolean().optional().default(false) },
  }, async (input) => asText(await cdp.heapSnapshot(input)));

  tool("performance_trace", {
    title: "Record performance trace",
    description: "Start or stop CDP Tracing and write bounded events to a private local artifact.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["start", "stop"]), categories: z.array(z.string().max(500)).max(100).optional(), timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000) },
  }, async (input) => asText(await cdp.trace(input)));

  tool("profiler_cpu", {
    title: "Record CPU profile",
    description: "Start or stop the CDP CPU profiler and return the profile plus bounded hotspots.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["start", "stop"]) },
  }, async (input) => asText(await cdp.cpuProfiler(input)));

  tool("profiler_heap_sampling", {
    title: "Record heap allocation sampling",
    description: "Start or stop CDP HeapProfiler allocation sampling.",
    inputSchema: { sessionId, targetSessionId, action: z.enum(["start", "stop"]), samplingInterval: z.number().int().min(1_024).max(16_777_216).optional().default(32_768) },
  }, async (input) => asText(await cdp.heapSampling(input)));

  tool("console_get_exceptions", {
    title: "Get page exceptions",
    description: "Enable Runtime, consume Raw exception events, and return bounded unsanitized exception details.",
    inputSchema: { sessionId, targetSessionId, timeoutMs, clear: z.boolean().optional().default(true) },
  }, async (input) => asText(await cdp.exceptions(input)));

  tool("network_get_response_body", {
    title: "Get raw response body",
    description: "Read one response body by its original CDP requestId. The result is unsanitized and may contain secrets or private data.",
    inputSchema: { sessionId, targetSessionId, requestId: z.string().min(1).max(500) },
  }, async (input) => asText(await cdp.networkBody(input)));

  tool("network_get_stats", {
    title: "Get raw network statistics",
    description: "Consume unsanitized Raw Network events and summarize counts, status, types, bytes, failures, and duration.",
    inputSchema: { sessionId, targetSessionId, timeoutMs },
  }, async (input) => asText(await cdp.networkStats(input)));

  tool("network_export_har", {
    title: "Export raw network HAR",
    description: "Write captured unsanitized requests, headers, and post data to a private local HAR artifact. Requires explicit confirmation.",
    inputSchema: { sessionId, targetSessionId, timeoutMs, confirmed: z.boolean().optional().default(false) },
  }, async (input) => {
    requireConfirmed(input, "confirmed=true is required because HAR export persists sensitive request data locally");
    return asText(await cdp.exportHar(input));
  });

  tool("network_extract_auth", {
    title: "Extract raw authentication material",
    description: "Extract authentication headers and associated cookies from captured Raw events. Requires explicit confirmation and returns secrets.",
    inputSchema: { sessionId, targetSessionId, timeoutMs, confirmed: z.boolean().optional().default(false) },
  }, async (input) => {
    requireConfirmed(input, "confirmed=true is required because authentication extraction returns secrets");
    return asText(await cdp.extractAuth(input));
  });

  const headerEntry = z.object({ name: z.string().min(1).max(500), value: z.string().max(200_000) });
  tool("network_intercept", {
    title: "Manage Fetch interception",
    description: "Enable, poll, continue, fail, fulfill, list, or disable explicit CDP Fetch interception. Paused requests remain blocked until handled or interception is disabled.",
    inputSchema: {
      sessionId,
      targetSessionId,
      action: z.enum(["enable", "poll", "continue", "fail", "fulfill", "list", "disable"]),
      patterns: z.array(z.object({ urlPattern: z.string().max(20_000).optional(), resourceType: z.string().max(100).optional(), requestStage: z.enum(["Request", "Response"]).optional() })).max(100).optional(),
      handleAuthRequests: z.boolean().optional().default(false),
      timeoutMs,
      requestId: z.string().max(500).optional(),
      url: z.string().max(20_000).optional(),
      method: z.string().max(50).optional(),
      headers: z.array(headerEntry).max(500).optional(),
      postDataBase64: z.string().max(3_000_000).optional(),
      errorReason: z.string().max(100).optional(),
      responseCode: z.number().int().min(100).max(599).optional(),
      responseHeaders: z.array(headerEntry).max(500).optional(),
      bodyBase64: z.string().max(3_000_000).optional(),
    },
  }, async (input) => {
    if (["continue", "fail", "fulfill"].includes(input.action) && !input.requestId) throw new Error(`${input.action} requires requestId`);
    return asText(await cdp.intercept(input));
  });
}
