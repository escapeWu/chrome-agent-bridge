import { z } from "zod";
import {
  TransformEngine,
  analysisAstMatch,
  analysisDataFlow,
  analysisSecurityScan,
  cryptoCompare,
  cryptoTestHarness,
  decodeStringArrays,
  deflatControlFlow,
  deobfuscatePipeline,
  detectCrypto,
  detectObfuscation,
  solveConstraints,
  supportedTransforms,
  understandCode,
} from "../lib/js-analysis.mjs";
import {
  binaryDecode,
  binaryEncode,
  decodeInput,
  detectBinaryFormat,
  entropy,
  protobufDecodeRaw,
  transformWorkbench,
} from "../lib/binary-analysis.mjs";
import {
  autoDetectProtocol,
  buildGrpcFrames,
  dissectDns,
  dissectHttp,
  exportProtocolSchema,
  fingerprintProtocol,
  http2Fingerprint,
  inferProtocolFields,
  inferProtocolStateMachine,
  parseGrpcFrames,
  parseHttp2Frames,
  visualizeProtocolState,
} from "../lib/protocol-analysis.mjs";
import { extractWasmStrings, inspectWasm } from "../lib/wasm-analysis.mjs";

const transforms = new TransformEngine();
const code = z.string().min(1).max(3_000_000);
const encodedData = z.string().max(12_000_000);
const transform = z.enum(supportedTransforms);

function requireExactlyOne(input, left, right) {
  if (Boolean(input[left]) === Boolean(input[right])) throw new Error(`Exactly one of ${left} or ${right} is required`);
}

export function registerLocalAnalysisTools({ tool, asText }) {
  tool("understand_code", {
    title: "Understand JavaScript",
    description: "Parse supplied JavaScript locally and summarize structure, calls, complexity, globals, and optional security signals. No browser session is required.",
    inputSchema: { code, focus: z.enum(["structure", "business", "security", "all"]).optional().default("all") },
  }, async (input) => asText(understandCode(input.code, input)));

  tool("analysis_ast_match", {
    title: "Match JavaScript AST",
    description: "Find AST nodes by Acorn node type and optional property filters.",
    inputSchema: { code, nodeType: z.string().min(1).max(100), filter: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().default({}), maxResults: z.number().int().min(1).max(500).optional().default(50) },
  }, async (input) => asText(analysisAstMatch(input.code, input)));

  tool("detect_obfuscation", {
    title: "Detect JavaScript obfuscation",
    description: "Score supplied JavaScript for common obfuscation signals using local deterministic heuristics.",
    inputSchema: { code },
  }, async (input) => asText(detectObfuscation(input.code)));

  tool("analysis_deflat_control_flow", {
    title: "Deflat JavaScript control flow",
    description: "Conservatively restore a canonical while(true)+switch dispatcher when its static order can be proven.",
    inputSchema: { code },
  }, async (input) => asText(deflatControlFlow(input.code)));

  tool("analysis_decode_string_array", {
    title: "Decode JavaScript string arrays",
    description: "Replace statically resolvable literal array member accesses with their literal values.",
    inputSchema: { code },
  }, async (input) => asText(decodeStringArrays(input.code)));

  tool("analysis_data_flow", {
    title: "Analyze JavaScript data flow",
    description: "Produce a bounded intra-file source, assignment, sink, and shallow taint-path projection.",
    inputSchema: { code },
  }, async (input) => asText(analysisDataFlow(input.code)));

  tool("analysis_security_scan", {
    title: "Scan JavaScript security risks",
    description: "Run a deterministic static heuristic scan for dynamic code, injection sinks, weak randomness, hard-coded credentials, and related risks.",
    inputSchema: { code },
  }, async (input) => asText(analysisSecurityScan(input.code)));

  tool("detect_crypto", {
    title: "Detect cryptography",
    description: "Identify common cryptographic algorithms and operations referenced by supplied JavaScript.",
    inputSchema: { code },
  }, async (input) => asText(detectCrypto(input.code)));

  tool("js_deobfuscate_pipeline", {
    title: "Run JavaScript deobfuscation pipeline",
    description: "Run conservative constant folding, dead-branch removal, string-array decoding, and optional control-flow deflattening.",
    inputSchema: { code, aggressive: z.boolean().optional().default(false) },
  }, async (input) => asText(deobfuscatePipeline(input.code, input)));

  tool("js_solve_constraints", {
    title: "Solve JavaScript constant constraints",
    description: "Fold safe literal binary expressions and prune literal boolean branches without executing supplied code.",
    inputSchema: { code, maxIterations: z.number().int().min(1).max(1_000).optional().default(100) },
  }, async (input) => asText(solveConstraints(input.code, input)));

  tool("ast_transform_preview", {
    title: "Preview AST transforms",
    description: "Preview supported deterministic JavaScript transforms and return a bounded line diff.",
    inputSchema: { code, transforms: z.array(transform).min(1).max(20) },
  }, async (input) => asText(transforms.preview(input.code, input.transforms)));

  tool("ast_transform_chain", {
    title: "Save AST transform chain",
    description: "Create an in-memory named transform chain for this MCP process.",
    inputSchema: { name: z.string().min(1).max(120), description: z.string().max(500).optional(), transforms: z.array(transform).min(1).max(20) },
  }, async (input) => asText({ success: true, chain: transforms.saveChain(input.name, input.transforms, input.description) }));

  tool("ast_transform_apply", {
    title: "Apply AST transforms",
    description: "Apply inline transforms or a previously saved transform chain to supplied JavaScript.",
    inputSchema: { code, transforms: z.array(transform).min(1).max(20).optional(), chainName: z.string().min(1).max(120).optional() },
  }, async (input) => {
    requireExactlyOne(input, "transforms", "chainName");
    return asText(transforms.apply(input.code, input.transforms, input.chainName));
  });

  tool("crypto_test_harness", {
    title: "Test extracted crypto function",
    description: "Run a supplied function against deterministic string inputs in a bounded Worker and vm context. This is defense in depth, not a security sandbox.",
    inputSchema: { code, functionName: z.string().regex(/^[A-Za-z_$][\w$]*$/), testInputs: z.array(z.string().max(100_000)).min(1).max(100), timeoutMs: z.number().int().min(10).max(10_000).optional().default(1_000) },
  }, async (input) => asText(await cryptoTestHarness(input.code, input.functionName, input.testInputs, input)));

  tool("crypto_compare", {
    title: "Compare crypto implementations",
    description: "Run two supplied implementations against identical inputs in separate bounded Workers and compare outputs.",
    inputSchema: { code1: code, code2: code, functionName: z.string().regex(/^[A-Za-z_$][\w$]*$/), testInputs: z.array(z.string().max(100_000)).min(1).max(100), timeoutMs: z.number().int().min(10).max(10_000).optional().default(1_000) },
  }, async (input) => asText(await cryptoCompare(input.code1, input.code2, input.functionName, input.testInputs, input)));

  const workbenchStep = z.object({ op: z.enum(["xor", "rc4", "gunzip", "inflate", "inflate_raw", "base64_decode", "base64_encode", "hex_decode", "hex_encode"]), key: z.string().max(10_000).optional(), keyHex: z.string().max(20_000).optional() });
  tool("transform_workbench", {
    title: "Transform binary payload",
    description: "Run a reproducible local binary transform pipeline over base64 input.",
    inputSchema: { inputBase64: encodedData, steps: z.array(workbenchStep).min(1).max(50), previewBytes: z.number().int().min(1).max(4_096).optional().default(256), includeOutputBase64: z.boolean().optional().default(true) },
  }, async (input) => asText(transformWorkbench(input.inputBase64, input.steps, input)));

  const inputEncoding = z.enum(["base64", "hex", "utf8"]);
  tool("binary_detect_format", {
    title: "Detect binary format",
    description: "Detect common binary formats from magic bytes, text signatures, and entropy.",
    inputSchema: { data: encodedData, inputEncoding: inputEncoding.optional().default("base64") },
  }, async (input) => asText(detectBinaryFormat(decodeInput(input.data, input.inputEncoding))));

  tool("binary_decode", {
    title: "Decode binary payload",
    description: "Decode between base64, hex, UTF-8, and JSON representations.",
    inputSchema: { data: encodedData, inputEncoding: inputEncoding.optional().default("base64"), outputEncoding: z.enum(["base64", "hex", "utf8", "json"]).optional().default("utf8") },
  }, async (input) => asText(binaryDecode(input.data, input.inputEncoding, input.outputEncoding)));

  tool("binary_encode", {
    title: "Encode binary payload",
    description: "Encode UTF-8, hex, base64, or JSON input into base64, hex, or UTF-8.",
    inputSchema: { data: z.any(), inputEncoding: z.enum(["base64", "hex", "utf8", "json"]).optional().default("utf8"), outputEncoding: z.enum(["base64", "hex", "utf8"]).optional().default("base64") },
  }, async (input) => asText(binaryEncode(input.data, input.inputEncoding, input.outputEncoding)));

  tool("binary_entropy_analysis", {
    title: "Analyze binary entropy",
    description: "Calculate Shannon entropy and byte-frequency distribution for a bounded payload.",
    inputSchema: { data: encodedData, inputEncoding: inputEncoding.optional().default("base64") },
  }, async (input) => asText({ success: true, ...entropy(decodeInput(input.data, input.inputEncoding)) }));

  tool("protobuf_decode_raw", {
    title: "Decode raw Protobuf",
    description: "Recursively decode schema-less Protobuf wire fields from base64 input.",
    inputSchema: { dataBase64: encodedData, maxDepth: z.number().int().min(0).max(10).optional().default(4), maxFields: z.number().int().min(1).max(10_000).optional().default(1_000) },
  }, async (input) => asText(protobufDecodeRaw(input.dataBase64, input)));

  tool("http2_frame_parse", {
    title: "Parse HTTP/2 frames",
    description: "Parse one or more raw HTTP/2 frames from hex, including common frame payloads.",
    inputSchema: { inputHex: encodedData },
  }, async (input) => asText(parseHttp2Frames(input.inputHex)));

  tool("network_http2_fingerprint", {
    title: "Fingerprint HTTP/2 preface",
    description: "Calculate an Akamai-style deterministic fingerprint from captured HTTP/2 preface frames.",
    inputSchema: { inputHex: encodedData },
  }, async (input) => asText(http2Fingerprint(input.inputHex)));

  tool("grpc_frame_parse", {
    title: "Parse gRPC frames",
    description: "Split gRPC or gRPC-Web length-prefixed messages and trailer frames.",
    inputSchema: { data: encodedData, encoding: inputEncoding.optional().default("base64"), strict: z.boolean().optional().default(false) },
  }, async (input) => asText(parseGrpcFrames(input.data, input.encoding, input)));

  tool("grpc_frame_build", {
    title: "Build gRPC frames",
    description: "Build deterministic gRPC or gRPC-Web length-prefixed messages.",
    inputSchema: { messages: z.array(z.object({ payloadBase64: encodedData.optional(), payloadHex: encodedData.optional(), compressed: z.boolean().optional(), isTrailer: z.boolean().optional() })).min(1).max(1_000), outputEncoding: z.enum(["base64", "hex"]).optional().default("base64") },
  }, async (input) => {
    for (const message of input.messages) requireExactlyOne(message, "payloadBase64", "payloadHex");
    return asText(buildGrpcFrames(input.messages, input.outputEncoding));
  });

  const samplesHex = z.array(encodedData).min(1).max(1_000);
  tool("proto_auto_detect", {
    title: "Detect protocol",
    description: "Classify bounded hex payload samples as HTTP, HTTP/2, TLS, DNS, SSH, WebSocket, or unknown.",
    inputSchema: { samplesHex },
  }, async (input) => asText(autoDetectProtocol(input.samplesHex)));

  tool("proto_infer_fields", {
    title: "Infer protocol fields",
    description: "Infer constant, variable, and variable-tail byte regions across repeated hex payloads.",
    inputSchema: { samplesHex: z.array(encodedData).min(2).max(1_000) },
  }, async (input) => asText(inferProtocolFields(input.samplesHex)));

  const protocolMessage = z.object({ direction: z.enum(["client", "server", "inbound", "outbound", "unknown"]).optional(), payloadHex: encodedData, timestamp: z.number().optional() });
  tool("proto_infer_state_machine", {
    title: "Infer protocol state machine",
    description: "Infer a deterministic state graph from direction, protocol fingerprint, and payload prefix.",
    inputSchema: { messages: z.array(protocolMessage).min(1).max(10_000) },
  }, async (input) => asText(inferProtocolStateMachine(input.messages)));

  const inferredField = z.object({ name: z.string().max(120).optional(), type: z.string().max(80).optional(), kind: z.string().max(80).optional(), offset: z.number().int().nonnegative().optional(), length: z.number().int().nonnegative().optional() });
  tool("proto_export_schema", {
    title: "Export protocol schema",
    description: "Export inferred fields as a compact proto-like schema for review.",
    inputSchema: { name: z.string().min(1).max(120), fields: z.array(inferredField).max(10_000) },
  }, async (input) => asText(exportProtocolSchema(input.name, input.fields)));

  tool("proto_visualize_state", {
    title: "Visualize protocol state",
    description: "Render an inferred state machine as Mermaid stateDiagram-v2 text.",
    inputSchema: { machine: z.object({ initialState: z.string().optional(), states: z.array(z.object({ id: z.string(), count: z.number().optional() })), transitions: z.array(z.object({ from: z.string(), to: z.string(), count: z.number().optional() })) }) },
  }, async (input) => asText(visualizeProtocolState(input.machine)));

  tool("proto_dissect_dns", {
    title: "Dissect DNS payload",
    description: "Parse an RFC 1035-style DNS payload from hex, including compressed names and common addresses.",
    inputSchema: { payloadHex: encodedData },
  }, async (input) => asText(dissectDns(input.payloadHex)));

  tool("proto_dissect_http", {
    title: "Dissect HTTP/1 payload",
    description: "Parse an HTTP/1 request or response start line, headers, and bounded body representations.",
    inputSchema: { payload: encodedData, encoding: inputEncoding.optional().default("utf8") },
  }, async (input) => asText(dissectHttp(input.payload, input.encoding)));

  tool("proto_fingerprint", {
    title: "Fingerprint protocol payload",
    description: "Fingerprint one raw hex payload without sending network traffic.",
    inputSchema: { payloadHex: encodedData },
  }, async (input) => asText(fingerprintProtocol(input.payloadHex)));

  const wasmInput = { inputBase64: encodedData.optional(), inputPath: z.string().min(1).max(4_096).optional() };
  tool("wasm_inspect", {
    title: "Inspect WebAssembly module",
    description: "Inspect a WASM module's sections, imports, exports, names, and producers using a local dependency-free structural parser.",
    inputSchema: wasmInput,
  }, async (input) => {
    requireExactlyOne(input, "inputBase64", "inputPath");
    return asText(await inspectWasm(input));
  });

  tool("wasm_string_extract", {
    title: "Extract WebAssembly strings",
    description: "Extract printable strings by WASM section and classify URLs, hashes, base64, and paths.",
    inputSchema: { ...wasmInput, minLength: z.number().int().min(1).max(1_024).optional().default(4), maxStrings: z.number().int().min(1).max(10_000).optional().default(500) },
  }, async (input) => {
    requireExactlyOne(input, "inputBase64", "inputPath");
    return asText(await extractWasmStrings(input, input));
  });
}
