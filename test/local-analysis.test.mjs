import assert from "node:assert/strict";
import test from "node:test";
import {
  TransformEngine,
  analysisAstMatch,
  analysisDataFlow,
  analysisSecurityScan,
  cryptoCompare,
  decodeStringArrays,
  detectCrypto,
  detectObfuscation,
  understandCode,
} from "../lib/js-analysis.mjs";
import {
  detectBinaryFormat,
  protobufDecodeRaw,
  transformWorkbench,
} from "../lib/binary-analysis.mjs";
import {
  buildGrpcFrames,
  dissectHttp,
  http2Fingerprint,
  inferProtocolFields,
  parseGrpcFrames,
  parseHttp2Frames,
} from "../lib/protocol-analysis.mjs";
import { SourceMapEngine } from "../lib/source-map-analysis.mjs";
import { extractWasmStrings, inspectWasm } from "../lib/wasm-analysis.mjs";

test("local JavaScript analyzers return structured deterministic results", () => {
  const code = `
    import value from "pkg";
    const names = ["alpha", "beta"];
    function sign(input) { return crypto.subtle.digest("SHA-256", input); }
    const selected = names[1];
    document.body.innerHTML = location.hash;
  `;
  const understood = understandCode(code);
  assert.equal(understood.structure.functionCount, 1);
  assert.equal(understood.structure.imports[0].source, "pkg");
  assert.ok(understood.calls.some((call) => call.name === "crypto.subtle.digest"));

  const matches = analysisAstMatch(code, { nodeType: "CallExpression" });
  assert.equal(matches.total, 1);
  assert.equal(detectCrypto(code).algorithms.some((item) => item.algorithm === "SHA-2"), true);
  assert.equal(detectObfuscation(code).success, true);
  assert.equal(analysisSecurityScan(code).risks.some((risk) => risk.id === "html-injection"), true);
  assert.equal(analysisDataFlow(code).sources.some((source) => source.kind === "location"), true);

  const decoded = decodeStringArrays(code);
  assert.equal(decoded.decodedCount, 1);
  assert.match(decoded.transformedCode, /const selected = "beta"/);
});

test("transform chains and isolated crypto comparisons work", async () => {
  const engine = new TransformEngine();
  engine.saveChain("clean", ["constant_fold", "dead_code_remove"]);
  const result = engine.apply("const n = 1 + 2; if (false) alert(1);", undefined, "clean");
  assert.match(result.transformed, /const n = 3/);
  assert.doesNotMatch(result.transformed, /alert/);

  const compared = await cryptoCompare(
    "function encode(v) { return v + '!'; }",
    "function encode(v) { return `${v}!`; }",
    "encode",
    ["a", "b"],
    { timeoutMs: 1_000 },
  );
  assert.equal(compared.equivalent, true);
});

test("binary, protobuf, HTTP2, gRPC, and HTTP projections are bounded", () => {
  assert.equal(detectBinaryFormat(Buffer.from("0061736d01000000", "hex")).format, "wasm");
  const protobuf = protobufDecodeRaw(Buffer.from("0a026869", "hex").toString("base64"));
  assert.equal(protobuf.fields[0].valueUtf8, "hi");

  const settingsFrame = "000006040000000000000100001000";
  const parsedH2 = parseHttp2Frames(settingsFrame);
  assert.equal(parsedH2.frames[0].settings[0].value, 4096);
  assert.equal(http2Fingerprint(settingsFrame).settings[0].id, 1);

  const builtGrpc = buildGrpcFrames([{ payloadHex: "0a026869" }], "base64");
  const parsedGrpc = parseGrpcFrames(builtGrpc.data, "base64");
  assert.equal(parsedGrpc.messages[0].payloadHex, "0a026869");

  const http = dissectHttp("GET /x HTTP/1.1\r\nHost: example.com\r\n\r\n", "utf8");
  assert.equal(http.method, "GET");
  assert.equal(http.headers[0].name, "Host");

  const inferred = inferProtocolFields(["01020304", "01090304"]);
  assert.equal(inferred.fields.some((field) => field.kind === "variable"), true);

  const workbench = transformWorkbench(Buffer.from("abc").toString("base64"), [{ op: "xor", key: "k" }]);
  assert.equal(workbench.applied[0].op, "xor");
});

test("source maps and minimal WASM modules are inspected locally", async () => {
  const maps = new SourceMapEngine();
  const parsed = maps.parse({ version: 3, file: "out.js", sources: ["src/a.js"], sourcesContent: ["const a = 1;"], names: [], mappings: "AAAA" });
  assert.equal(parsed.sources[0].source, "src/a.js");
  assert.equal(maps.lookup(parsed.mapId, 1, 0).original.source, "src/a.js");
  assert.equal(maps.reconstruct(parsed.mapId, { includeContents: true }).files[0].content, "const a = 1;");

  const indexed = maps.parse({
    version: 3,
    sections: [{ offset: { line: 0, column: 0 }, map: { version: 3, sources: ["src/indexed.js"], sourcesContent: ["const indexed = true;"], names: [], mappings: "AAAA" } }],
  });
  assert.equal(indexed.sources[0].source, "src/indexed.js");
  assert.equal(maps.coverage(indexed.mapId).sources[0].source, "src/indexed.js");
  assert.equal(maps.reconstruct(indexed.mapId, { includeContents: true }).files[0].content, "const indexed = true;");

  const minimal = Buffer.from("0061736d01000000", "hex").toString("base64");
  const inspected = await inspectWasm({ inputBase64: minimal });
  assert.equal(inspected.version, 1);
  assert.equal(inspected.sections.length, 0);
  const strings = await extractWasmStrings({ inputBase64: minimal }, { minLength: 2 });
  assert.equal(strings.success, true);
});
