# Protocol, binary, and WASM analysis

These tools operate on supplied data in the MCP process; Chrome is not required.

## Binary and encoding

- `binary_detect_format`, `binary_entropy_analysis`: inspect bounded base64, hex, or UTF-8 data.
- `binary_decode`, `binary_encode`: convert base64, hex, UTF-8, and JSON representations.
- `protobuf_decode_raw`: schema-less wire projection; nested bytes may be represented as both base64 and a candidate message.

## HTTP/2, gRPC, and protocols

- `http2_frame_parse`, `network_http2_fingerprint`: parse captured frame bytes; they do not capture traffic.
- `grpc_frame_parse`, `grpc_frame_build`: split or build length-prefixed gRPC/gRPC-Web messages.
- `proto_auto_detect`, `proto_fingerprint`: bounded deterministic protocol classification.
- `proto_infer_fields`: compare at least two hex samples.
- `proto_infer_state_machine` → `proto_visualize_state`: cluster message sequences and render Mermaid.
- `proto_export_schema`: emit a proto-like review artifact.
- `proto_dissect_dns`, `proto_dissect_http`: offline payload dissection.

These are projections, not authoritative protocol verification. Preserve the original samples for independent comparison.

## WASM

- `wasm_inspect`: pure JavaScript structural parsing of sections, imports, exports, names, and producers.
- `wasm_string_extract`: section-aware printable strings and categories.

Pass exactly one of `inputBase64` or `inputPath`. These tools do not disassemble code bodies and do not require WABT, Binaryen, Wasmtime, or another external service.
