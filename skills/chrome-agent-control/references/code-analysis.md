# Local code analysis

Read this reference for supplied JavaScript. These tools run in the MCP process and do not require Chrome.

## Inspect

- `understand_code`: structure, calls, complexity, globals, and security summary.
- `analysis_ast_match`: Acorn AST nodes by `nodeType` and optional property filter.
- `detect_obfuscation` / `detect_crypto`: deterministic signal detection.
- `analysis_data_flow`: shallow intra-file source-to-sink projection.
- `analysis_security_scan`: heuristic findings requiring human verification.

## Transform

- `analysis_decode_string_array`: resolve literal array member access.
- `analysis_deflat_control_flow`: restore only a statically proven canonical switch dispatcher.
- `js_solve_constraints`: constant folding and literal dead-branch removal.
- `js_deobfuscate_pipeline`: conservative pipeline; set `aggressive=true` only when deflattening is wanted.
- `ast_transform_preview`: inspect a diff before applying.
- `ast_transform_chain`: save a named in-memory chain.
- `ast_transform_apply`: pass either `transforms` or `chainName`, never both.

Supported transforms are `constant_fold`, `dead_code_remove`, `decode_string_array`, `deflat_control_flow`, `strip_debugger`, and `unescape_strings`.

## Execute test vectors

`crypto_test_harness` and `crypto_compare` run supplied functions in bounded Worker/vm contexts. Treat this as defense in depth, not a security sandbox. Prefer static analysis for untrusted code; keep test inputs and timeouts small.

`transform_workbench` operates on base64 payloads with bounded XOR, RC4, decompression, base64, or hex steps.
