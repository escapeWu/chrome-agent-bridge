import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("MCP server exposes the browser and analysis tool surface", async (context) => {
  const bridgeDir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-bridge-test-"));
  context.after(() => fs.rm(bridgeDir, { recursive: true, force: true }));

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "mcp", "server.mjs")],
    cwd: root,
    env: {
      PATH: process.env.PATH || "",
      CHROME_AGENT_BRIDGE_DIR: bridgeDir,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "chrome-agent-bridge-test", version: "1.0.0" });
  context.after(() => client.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "analysis_ast_match",
      "analysis_data_flow",
      "analysis_decode_string_array",
      "analysis_deflat_control_flow",
      "analysis_security_scan",
      "ast_transform_apply",
      "ast_transform_chain",
      "ast_transform_preview",
      "binary_decode",
      "binary_detect_format",
      "binary_encode",
      "binary_entropy_analysis",
      "blackbox_add",
      "blackbox_add_common",
      "blackbox_list",
      "breakpoint",
      "browser_act",
      "browser_activate_tab",
      "browser_cdp_attach",
      "browser_cdp_detach",
      "browser_cdp_events",
      "browser_cdp_send",
      "browser_click",
      "browser_close_tab",
      "browser_fill",
      "browser_list_tabs",
      "browser_navigate",
      "browser_network_poll",
      "browser_network_start",
      "browser_network_stop",
      "browser_open_tab",
      "browser_screenshot",
      "browser_snapshot",
      "browser_status",
      "browser_watch_events",
      "collect_code",
      "console_get_exceptions",
      "crypto_compare",
      "crypto_test_harness",
      "debugger_capture_hit",
      "debugger_disassemble",
      "debugger_evaluate",
      "debugger_get_paused_state",
      "debugger_lifecycle",
      "debugger_pause",
      "debugger_resume",
      "debugger_run_to_location",
      "debugger_session",
      "debugger_step",
      "debugger_wait_for_paused",
      "detect_crypto",
      "detect_obfuscation",
      "extract_function_tree",
      "get_call_stack",
      "get_object_properties",
      "get_scope_variables_enhanced",
      "grpc_frame_build",
      "grpc_frame_parse",
      "http2_frame_parse",
      "js_deobfuscate_pipeline",
      "js_solve_constraints",
      "network_export_har",
      "network_extract_auth",
      "network_get_response_body",
      "network_get_stats",
      "network_http2_fingerprint",
      "network_intercept",
      "performance_coverage",
      "performance_get_metrics",
      "performance_take_heap_snapshot",
      "performance_trace",
      "profiler_cpu",
      "profiler_heap_sampling",
      "proto_auto_detect",
      "proto_dissect_dns",
      "proto_dissect_http",
      "proto_export_schema",
      "proto_fingerprint",
      "proto_infer_fields",
      "proto_infer_state_machine",
      "proto_visualize_state",
      "protobuf_decode_raw",
      "search_in_scripts",
      "sourcemap_coverage",
      "sourcemap_diff",
      "sourcemap_discover",
      "sourcemap_fetch_and_parse",
      "sourcemap_lookup",
      "sourcemap_parse_v4",
      "sourcemap_reconstruct_tree",
      "transform_workbench",
      "understand_code",
      "wasm_inspect",
      "wasm_string_extract",
      "watch",
      "webpack_enumerate",
    ],
  );

  const networkStart = tools.find((tool) => tool.name === "browser_network_start");
  assert.equal(networkStart.inputSchema.properties.rawSessionId.type, "string");
  assert.equal(networkStart.inputSchema.properties.urlMode.default, "origin_path");
  assert.deepEqual(networkStart.inputSchema.properties.urlMode.enum, ["origin_path", "full"]);

  const rawAttach = tools.find((tool) => tool.name === "browser_cdp_attach");
  assert.equal(rawAttach.inputSchema.properties.captureEvents.default, true);
  assert.equal(rawAttach.inputSchema.properties.maxBytes.maximum, 64 * 1024 * 1024);

  const pageAct = tools.find((tool) => tool.name === "browser_act");
  assert.deepEqual(pageAct.inputSchema.properties.kind.enum, ["click", "fill", "press", "select"]);
  assert.equal(pageAct.inputSchema.properties.ref.pattern, "^e\\d+$");

  const collectCode = tools.find((tool) => tool.name === "collect_code");
  assert.equal(collectCode.inputSchema.required.includes("sessionId"), true);
  assert.equal(collectCode.inputSchema.properties.includeSource.default, true);

  const authExtract = tools.find((tool) => tool.name === "network_extract_auth");
  assert.equal(authExtract.inputSchema.properties.confirmed.default, false);

  const astPreview = tools.find((tool) => tool.name === "ast_transform_preview");
  assert.deepEqual(astPreview.inputSchema.properties.transforms.items.enum, [
    "constant_fold",
    "dead_code_remove",
    "decode_string_array",
    "deflat_control_flow",
    "strip_debugger",
    "unescape_strings",
  ]);

  const status = await client.callTool({ name: "browser_status", arguments: {} });
  assert.equal(status.isError, true);
  assert.match(status.content[0].text, /bridge_offline/);

  const authWithoutConfirmation = await client.callTool({
    name: "network_extract_auth",
    arguments: { sessionId: "raw_12345678901234567890" },
  });
  assert.equal(authWithoutConfirmation.isError, true);
  assert.match(authWithoutConfirmation.content[0].text, /confirmation_required/);
});
