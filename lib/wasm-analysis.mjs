import fs from "node:fs/promises";
import path from "node:path";
import { decodeInput } from "./binary-analysis.mjs";

const MAX_WASM_BYTES = 16 * 1024 * 1024;
const SECTION_NAMES = ["custom", "type", "import", "function", "table", "memory", "global", "export", "start", "element", "code", "data", "data-count", "tag"];

async function loadWasm({ inputBase64, inputPath }) {
  let buffer;
  if (inputBase64) buffer = decodeInput(inputBase64, "base64");
  else if (inputPath) {
    const resolved = path.resolve(inputPath);
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error("WASM inputPath must reference a regular file");
    if (stat.size > MAX_WASM_BYTES) throw new Error(`WASM input exceeds ${MAX_WASM_BYTES} bytes`);
    buffer = await fs.readFile(resolved);
  }
  else throw new Error("inputBase64 or inputPath is required");
  if (buffer.length > MAX_WASM_BYTES) throw new Error(`WASM input exceeds ${MAX_WASM_BYTES} bytes`);
  if (buffer.length < 8 || buffer.subarray(0, 4).toString("hex") !== "0061736d") throw new Error("Input is not a WebAssembly module");
  return buffer;
}

function readU32(buffer, state) {
  let value = 0;
  let shift = 0;
  for (let count = 0; count < 5; count += 1) {
    if (state.offset >= buffer.length) throw new Error("Truncated WASM LEB128");
    const byte = buffer[state.offset++];
    value |= (byte & 0x7f) << shift;
    if (count === 4 && (byte & 0xf0) !== 0) throw new Error("WASM u32 LEB128 overflows 32 bits");
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  throw new Error("WASM u32 LEB128 exceeds five bytes");
}

function readName(buffer, state) {
  const length = readU32(buffer, state);
  if (state.offset + length > buffer.length) throw new Error("Truncated WASM name");
  const value = buffer.subarray(state.offset, state.offset + length).toString("utf8");
  state.offset += length;
  return value;
}

function parseSections(buffer) {
  const sections = [];
  const state = { offset: 8 };
  while (state.offset < buffer.length) {
    const offset = state.offset;
    const id = buffer[state.offset++];
    const size = readU32(buffer, state);
    const payloadStart = state.offset;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > buffer.length) throw new Error(`WASM section ${id} exceeds input bounds`);
    let customName;
    if (id === 0 && size > 0) {
      const customState = { offset: payloadStart };
      try { customName = readName(buffer, customState); } catch {}
    }
    sections.push({ id, name: id === 0 && customName ? `custom:${customName}` : SECTION_NAMES[id] || `section-${id}`, offset, payloadStart, payloadEnd, size });
    state.offset = payloadEnd;
  }
  return sections;
}

function countVector(buffer, section) {
  if (!section || section.size === 0) return 0;
  const state = { offset: section.payloadStart };
  try { return readU32(buffer, state); } catch { return null; }
}

function skipLimits(buffer, state) {
  const flags = readU32(buffer, state);
  readU32(buffer, state);
  if (flags & 1) readU32(buffer, state);
}

function parseImports(buffer, section) {
  if (!section) return [];
  const state = { offset: section.payloadStart };
  const count = readU32(buffer, state);
  const imports = [];
  for (let index = 0; index < count && state.offset < section.payloadEnd; index += 1) {
    const module = readName(buffer, state);
    const name = readName(buffer, state);
    const kind = buffer[state.offset++];
    const entry = { module, name, kind: ["function", "table", "memory", "global", "tag"][kind] || String(kind) };
    if (kind === 0) entry.typeIndex = readU32(buffer, state);
    else if (kind === 1) {
      entry.elementType = buffer[state.offset++];
      skipLimits(buffer, state);
    } else if (kind === 2) skipLimits(buffer, state);
    else if (kind === 3) {
      entry.valueType = buffer[state.offset++];
      entry.mutable = Boolean(buffer[state.offset++]);
    } else if (kind === 4) {
      entry.attribute = readU32(buffer, state);
      entry.typeIndex = readU32(buffer, state);
    } else throw new Error(`Unsupported WASM import kind ${kind}`);
    imports.push(entry);
  }
  return imports;
}

function parseExports(buffer, section) {
  if (!section) return [];
  const state = { offset: section.payloadStart };
  const count = readU32(buffer, state);
  const exports = [];
  for (let index = 0; index < count && state.offset < section.payloadEnd; index += 1) {
    exports.push({ name: readName(buffer, state), kind: ["function", "table", "memory", "global", "tag"][buffer[state.offset++]] || "unknown", index: readU32(buffer, state) });
  }
  return exports;
}

function parseFunctionNames(buffer, section) {
  if (!section) return [];
  const state = { offset: section.payloadStart };
  try { readName(buffer, state); } catch { return []; }
  const names = [];
  while (state.offset < section.payloadEnd) {
    const subsectionId = buffer[state.offset++];
    const length = readU32(buffer, state);
    const end = state.offset + length;
    if (end > section.payloadEnd) break;
    if (subsectionId === 1) {
      const count = readU32(buffer, state);
      for (let index = 0; index < count && state.offset < end; index += 1) names.push({ index: readU32(buffer, state), name: readName(buffer, state) });
    }
    state.offset = end;
  }
  return names;
}

function parseProducers(buffer, section) {
  if (!section) return [];
  const state = { offset: section.payloadStart };
  try { readName(buffer, state); } catch { return []; }
  const fields = [];
  try {
    const fieldCount = readU32(buffer, state);
    for (let index = 0; index < fieldCount; index += 1) {
      const field = readName(buffer, state);
      const valueCount = readU32(buffer, state);
      const values = [];
      for (let valueIndex = 0; valueIndex < valueCount; valueIndex += 1) values.push({ name: readName(buffer, state), version: readName(buffer, state) });
      fields.push({ field, values });
    }
  } catch {}
  return fields;
}

export async function inspectWasm(input) {
  const buffer = await loadWasm(input);
  const sections = parseSections(buffer);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const customNames = sections.filter((section) => section.id === 0).map((section) => section.name.slice(7));
  const nameSection = sections.find((section) => section.name === "custom:name");
  const producerSection = sections.find((section) => section.name === "custom:producers");
  return {
    success: true,
    byteLength: buffer.length,
    version: buffer.readUInt32LE(4),
    sections: sections.map(({ payloadStart, payloadEnd, ...section }) => section),
    counts: {
      types: countVector(buffer, byId.get(1)),
      imports: countVector(buffer, byId.get(2)),
      functions: countVector(buffer, byId.get(3)),
      tables: countVector(buffer, byId.get(4)),
      memories: countVector(buffer, byId.get(5)),
      globals: countVector(buffer, byId.get(6)),
      exports: countVector(buffer, byId.get(7)),
      elements: countVector(buffer, byId.get(9)),
      codeBodies: countVector(buffer, byId.get(10)),
      dataSegments: countVector(buffer, byId.get(11)),
    },
    imports: parseImports(buffer, byId.get(2)),
    exports: parseExports(buffer, byId.get(7)),
    startFunction: byId.has(8) ? (() => { const state = { offset: byId.get(8).payloadStart }; return readU32(buffer, state); })() : null,
    customSections: customNames,
    functionNames: parseFunctionNames(buffer, nameSection),
    producers: parseProducers(buffer, producerSection),
    boundary: "Structural parser only; code bodies and validation semantics are not disassembled.",
  };
}

function classifyString(value) {
  const categories = [];
  if (/^https?:\/\//i.test(value) || /^wss?:\/\//i.test(value)) categories.push("url");
  if (/^[0-9a-f]{32,128}$/i.test(value)) categories.push("hex-hash");
  if (/^[A-Za-z0-9+/]{16,}={0,2}$/.test(value)) categories.push("base64");
  if (/(?:^|[/\\])[\w.-]+\.(?:js|wasm|json|png|jpe?g|html?|css|so|dex|apk|proto|wat|pem|crt)(?:$|\?)/i.test(value)) categories.push("file-path");
  return categories;
}

function printableRuns(buffer, start, end, minLength) {
  const strings = [];
  let runStart = -1;
  const flush = (finish) => {
    if (runStart >= 0 && finish - runStart >= minLength) strings.push({ value: buffer.subarray(runStart, finish).toString("latin1"), offset: runStart });
    runStart = -1;
  };
  for (let offset = start; offset < end; offset += 1) {
    const byte = buffer[offset];
    if (byte >= 0x20 && byte <= 0x7e) {
      if (runStart < 0) runStart = offset;
    } else flush(offset);
  }
  flush(end);
  return strings;
}

export async function extractWasmStrings(input, { minLength = 4, maxStrings = 500 } = {}) {
  if (!Number.isInteger(minLength) || minLength < 1 || minLength > 1_024) throw new Error("minLength must be an integer from 1 to 1024");
  if (!Number.isInteger(maxStrings) || maxStrings < 1 || maxStrings > 10_000) throw new Error("maxStrings must be an integer from 1 to 10000");
  const buffer = await loadWasm(input);
  const sections = parseSections(buffer);
  const strings = [];
  const bySection = {};
  for (const section of sections) {
    const found = printableRuns(buffer, section.payloadStart, section.payloadEnd, Math.max(1, minLength));
    bySection[section.name] = found.length;
    for (const item of found) strings.push({ ...item, section: section.name, categories: classifyString(item.value) });
  }
  const classified = {};
  for (const item of strings) for (const category of item.categories) (classified[category] ||= []).push(item);
  return {
    success: true,
    byteLength: buffer.length,
    sectionCount: sections.length,
    totalStrings: strings.length,
    returnedStrings: Math.min(strings.length, maxStrings),
    truncated: strings.length > maxStrings,
    bySection,
    classified,
    strings: strings.slice(0, maxStrings),
  };
}
