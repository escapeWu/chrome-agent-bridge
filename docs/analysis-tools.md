# Analysis tool catalog

Chrome Agent Bridge 0.8 adds 77 clean-room analysis tools in three batches. They are implemented with public JavaScript, source-map, binary-format, WebAssembly, and Chrome DevTools Protocol contracts. No JS Hook MCP code is copied, and no JS Hook service is required.

The 19 existing browser-control tools remain available, for 96 MCP tools in total. Agents should install the paired `chrome-agent-control` Skill and load only the scenario reference it routes to.

## What was intentionally excluded

The migration does not include proxy capture, a second browser runtime, Android/ADB, Frida, Ghidra, IDA, Binary Ninja, Rizin, JADX, apktool, CAPTCHA solving, daemon infrastructure, eBPF, process injection, external embedding downloads, WABT, or Binaryen. Those capabilities need another service, privileged OS access, a large runtime, or a materially wider security boundary.

## Batch 1: local JavaScript and payload analysis

These tools run entirely in the MCP process and do not require Chrome.

JavaScript inspection:

- `understand_code`
- `analysis_ast_match`
- `detect_obfuscation`
- `detect_crypto`
- `analysis_data_flow`
- `analysis_security_scan`

Conservative transformation:

- `analysis_deflat_control_flow`
- `analysis_decode_string_array`
- `js_deobfuscate_pipeline`
- `js_solve_constraints`
- `ast_transform_preview`
- `ast_transform_chain`
- `ast_transform_apply`

Bounded execution and payload transforms:

- `crypto_test_harness`
- `crypto_compare`
- `transform_workbench`

The AST and security results are deterministic projections, not proof of program behavior. The crypto harness uses Worker and VM time limits as defense in depth; it is not a security sandbox for hostile code.

## Batch 2: Raw CDP analysis projections

These tools reuse one explicit `browser_cdp_attach` session. They do not install a second browser or local daemon. Event-dependent tools require `captureEvents=true`; command-only workflows may keep it false.

Script collection:

- `collect_code`
- `search_in_scripts`
- `extract_function_tree`
- `webpack_enumerate`

Source maps:

- `sourcemap_discover`
- `sourcemap_fetch_and_parse`
- `sourcemap_coverage`
- `sourcemap_lookup`
- `sourcemap_reconstruct_tree`
- `sourcemap_parse_v4`
- `sourcemap_diff`

Debugger:

- `debugger_lifecycle`
- `debugger_pause`
- `debugger_resume`
- `debugger_run_to_location`
- `debugger_step`
- `breakpoint`
- `get_call_stack`
- `debugger_disassemble`
- `debugger_evaluate`
- `debugger_wait_for_paused`
- `debugger_capture_hit`
- `debugger_get_paused_state`
- `get_object_properties`
- `get_scope_variables_enhanced`
- `debugger_session`
- `watch`
- `blackbox_add`
- `blackbox_add_common`
- `blackbox_list`

Performance and exceptions:

- `performance_get_metrics`
- `performance_coverage`
- `performance_take_heap_snapshot`
- `performance_trace`
- `profiler_cpu`
- `profiler_heap_sampling`
- `console_get_exceptions`

Unsanitized network analysis:

- `network_get_response_body`
- `network_get_stats`
- `network_export_har`
- `network_extract_auth`
- `network_intercept`

Use the sanitized `browser_network_start`, `browser_network_poll`, and `browser_network_stop` tools unless the task truly needs headers, bodies, raw IDs, authentication material, or interception. HAR export and authentication extraction require `confirmed=true`. Debugger evaluation executes code in the page. Fetch interception can block the page until every request is handled or interception is disabled.

Raw event storage is bounded per session to at most 1,000 events and a caller-selected total up to 64 MiB. Each stored event and each poll page is capped at 2.5 MB; each command result is capped at 3 MB to stay below the 4 MiB Native Messaging envelope. A large trace or heap snapshot must use `captureEvents=true` and a deliberately increased `maxBytes`; incomplete artifacts fail instead of being silently written.

Trace, heap snapshot, and HAR files are written with user-only permissions under `~/.chrome-agent-bridge/artifacts/`. Detaching Raw clears the related in-memory analysis state.

## Batch 3: protocol, binary, and WASM analysis

These tools analyze supplied inputs locally. They do not capture network traffic.

Binary and Protobuf:

- `binary_detect_format`
- `binary_decode`
- `binary_encode`
- `binary_entropy_analysis`
- `protobuf_decode_raw`

HTTP/2, gRPC, and protocol inference:

- `http2_frame_parse`
- `network_http2_fingerprint`
- `grpc_frame_parse`
- `grpc_frame_build`
- `proto_auto_detect`
- `proto_infer_fields`
- `proto_infer_state_machine`
- `proto_export_schema`
- `proto_visualize_state`
- `proto_dissect_dns`
- `proto_dissect_http`
- `proto_fingerprint`

WebAssembly:

- `wasm_inspect`
- `wasm_string_extract`

WASM inspection is a bounded, pure-JavaScript structure parser for sections, imports, exports, names, producers, and printable strings. It does not disassemble code bodies or require WABT, Binaryen, Wasmtime, or another service.

## Recommended workflows

For supplied JavaScript:

```text
understand_code → detect_obfuscation or analysis_security_scan
  → ast_transform_preview → ast_transform_apply
```

For page scripts:

```text
browser_status → browser_list_tabs
  → browser_cdp_attach(captureEvents=true)
  → collect_code → search/debug/source-map tools
  → browser_cdp_detach
```

For a trace or deep network capture:

```text
browser_cdp_attach(captureEvents=true, maxBytes=authorized bounded size)
  → enable/start tool → perform the authorized action → stop/read tool
  → disable interception if used → browser_cdp_detach
```

For binary, protocol, or WASM input, call only the relevant local tool; a browser connection is unnecessary.
