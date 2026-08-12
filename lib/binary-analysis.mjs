import { gunzipSync, inflateRawSync, inflateSync } from "node:zlib";

const MAX_BINARY_BYTES = 8 * 1024 * 1024;

function bounded(buffer, label = "input") {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);
  if (buffer.length > MAX_BINARY_BYTES) {
    const error = new Error(`${label} exceeds ${MAX_BINARY_BYTES} bytes`);
    error.code = "analysis_input_too_large";
    throw error;
  }
  return buffer;
}

export function decodeInput(data, encoding = "base64") {
  if (typeof data !== "string") throw new Error("data must be a string");
  if (encoding === "utf8") return bounded(Buffer.from(data, "utf8"));
  if (encoding === "hex") {
    const normalized = data.replace(/\s+/g, "");
    if (normalized.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(normalized)) throw new Error("Invalid hex input");
    return bounded(Buffer.from(normalized, "hex"));
  }
  if (encoding === "base64") {
    const normalized = data.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(normalized) || normalized.length % 4 === 1) throw new Error("Invalid base64 input");
    const standard = normalized.replaceAll("-", "+").replaceAll("_", "/");
    const paddingIndex = standard.indexOf("=");
    if (paddingIndex >= 0 && paddingIndex < standard.length - (standard.endsWith("==") ? 2 : 1)) throw new Error("Invalid base64 padding");
    return bounded(Buffer.from(standard, "base64"));
  }
  throw new Error(`Unsupported input encoding: ${encoding}`);
}

export function entropy(buffer) {
  buffer = bounded(buffer);
  if (buffer.length === 0) return { entropy: 0, distribution: [], byteLength: 0 };
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte] += 1;
  let value = 0;
  const distribution = [];
  for (let byte = 0; byte < counts.length; byte += 1) {
    const count = counts[byte];
    if (!count) continue;
    const probability = count / buffer.length;
    value -= probability * Math.log2(probability);
    distribution.push({ byte, count, percent: Number((probability * 100).toFixed(4)) });
  }
  return {
    entropy: Number(value.toFixed(6)),
    byteLength: buffer.length,
    distribution: distribution.sort((a, b) => b.count - a.count),
  };
}

const MAGIC = [
  ["png", "89504e470d0a1a0a"],
  ["jpeg", "ffd8ff"],
  ["gif", "47494638"],
  ["pdf", "25504446"],
  ["zip", "504b0304"],
  ["gzip", "1f8b08"],
  ["wasm", "0061736d"],
  ["elf", "7f454c46"],
  ["pe", "4d5a"],
  ["sqlite", "53514c69746520666f726d6174203300"],
  ["webp", "52494646", 8, "57454250"],
];

export function detectBinaryFormat(buffer) {
  buffer = bounded(buffer);
  const hex = buffer.subarray(0, 32).toString("hex");
  const matches = [];
  for (const [format, prefix, secondaryOffset, secondary] of MAGIC) {
    if (!hex.startsWith(prefix)) continue;
    if (secondary && buffer.subarray(secondaryOffset, secondaryOffset + secondary.length / 2).toString("hex") !== secondary) continue;
    matches.push({ format, confidence: 1, evidence: prefix });
  }
  const text = buffer.subarray(0, 512).toString("utf8").trim();
  if (/^[\[{]/.test(text)) {
    try {
      JSON.parse(buffer.toString("utf8"));
      matches.push({ format: "json", confidence: 0.98, evidence: "valid-json" });
    } catch {}
  }
  if (/^<!doctype html|^<html[\s>]/i.test(text)) matches.push({ format: "html", confidence: 0.95, evidence: "html-root" });
  if (/^<\?xml|^<[A-Za-z_][\w:.-]*(?:\s|>)/.test(text)) matches.push({ format: "xml", confidence: 0.8, evidence: "xml-like-root" });
  const stats = entropy(buffer);
  return {
    success: true,
    byteLength: buffer.length,
    format: matches[0]?.format || (stats.entropy > 7.5 ? "high-entropy-binary" : "unknown"),
    matches,
    entropy: stats.entropy,
    previewHex: buffer.subarray(0, 64).toString("hex"),
    previewUtf8: buffer.subarray(0, 256).toString("utf8").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�"),
  };
}

export function binaryDecode(data, inputEncoding, outputEncoding) {
  const buffer = decodeInput(data, inputEncoding);
  if (outputEncoding === "hex") return { success: true, encoding: "hex", data: buffer.toString("hex"), byteLength: buffer.length };
  if (outputEncoding === "base64") return { success: true, encoding: "base64", data: buffer.toString("base64"), byteLength: buffer.length };
  if (outputEncoding === "utf8") return { success: true, encoding: "utf8", data: buffer.toString("utf8"), byteLength: buffer.length };
  if (outputEncoding === "json") return { success: true, encoding: "json", data: JSON.parse(buffer.toString("utf8")), byteLength: buffer.length };
  throw new Error(`Unsupported output encoding: ${outputEncoding}`);
}

export function binaryEncode(data, inputEncoding, outputEncoding) {
  const source = inputEncoding === "json" ? JSON.stringify(data) : String(data);
  const buffer = inputEncoding === "json" ? bounded(Buffer.from(source, "utf8")) : decodeInput(source, inputEncoding);
  if (outputEncoding === "base64") return { success: true, encoding: "base64", data: buffer.toString("base64"), byteLength: buffer.length };
  if (outputEncoding === "hex") return { success: true, encoding: "hex", data: buffer.toString("hex"), byteLength: buffer.length };
  if (outputEncoding === "utf8") return { success: true, encoding: "utf8", data: buffer.toString("utf8"), byteLength: buffer.length };
  throw new Error(`Unsupported output encoding: ${outputEncoding}`);
}

function readVarint(buffer, state) {
  let result = 0n;
  let shift = 0n;
  for (let count = 0; count < 10; count += 1) {
    if (state.offset >= buffer.length) throw new Error("Truncated protobuf varint");
    const byte = buffer[state.offset++];
    if (count === 9 && byte > 1) throw new Error("Protobuf varint exceeds uint64");
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7n;
  }
  throw new Error("Protobuf varint exceeds 10 bytes");
}

function bigintValue(value) {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function looksPrintable(buffer) {
  if (!buffer.length) return false;
  let printable = 0;
  for (const byte of buffer) if (byte === 9 || byte === 10 || byte === 13 || byte >= 32 && byte < 127) printable += 1;
  return printable / buffer.length >= 0.85;
}

function parseMessage(buffer, depth, maxDepth, maxFields) {
  const state = { offset: 0 };
  const fields = [];
  while (state.offset < buffer.length && fields.length < maxFields) {
    const fieldOffset = state.offset;
    const tag = readVarint(buffer, state);
    const fieldNumberRaw = tag >> 3n;
    if (fieldNumberRaw > 0x1fffffffn) throw new Error(`Invalid protobuf field number at offset ${fieldOffset}`);
    const fieldNumber = Number(fieldNumberRaw);
    const wireType = Number(tag & 7n);
    if (fieldNumber <= 0 || wireType > 5 || [3, 4].includes(wireType)) throw new Error(`Unsupported protobuf tag at offset ${fieldOffset}`);
    const field = { fieldNumber, wireType, offset: fieldOffset };
    if (wireType === 0) {
      field.value = bigintValue(readVarint(buffer, state));
    } else if (wireType === 1) {
      if (state.offset + 8 > buffer.length) throw new Error("Truncated fixed64 field");
      field.valueHex = buffer.subarray(state.offset, state.offset + 8).toString("hex");
      state.offset += 8;
    } else if (wireType === 2) {
      const length = Number(readVarint(buffer, state));
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > buffer.length) throw new Error("Invalid length-delimited protobuf field");
      const payload = buffer.subarray(state.offset, state.offset + length);
      state.offset += length;
      field.length = length;
      field.valueBase64 = payload.toString("base64");
      if (looksPrintable(payload)) field.valueUtf8 = payload.toString("utf8");
      if (depth < maxDepth && payload.length > 0) {
        try {
          const nested = parseMessage(payload, depth + 1, maxDepth, Math.min(maxFields, 200));
          if (nested.fields.length && nested.consumed === payload.length) field.message = nested.fields;
        } catch {}
      }
    } else if (wireType === 5) {
      if (state.offset + 4 > buffer.length) throw new Error("Truncated fixed32 field");
      field.valueHex = buffer.subarray(state.offset, state.offset + 4).toString("hex");
      state.offset += 4;
    }
    fields.push(field);
  }
  return { fields, consumed: state.offset, truncated: state.offset < buffer.length };
}

export function protobufDecodeRaw(dataBase64, { maxDepth = 4, maxFields = 1_000 } = {}) {
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 10) throw new Error("maxDepth must be an integer from 0 to 10");
  if (!Number.isInteger(maxFields) || maxFields < 1 || maxFields > 10_000) throw new Error("maxFields must be an integer from 1 to 10000");
  const buffer = decodeInput(dataBase64, "base64");
  const result = parseMessage(buffer, 0, maxDepth, maxFields);
  return { success: true, byteLength: buffer.length, ...result, schemaKnown: false };
}

function xorBuffer(buffer, key) {
  if (!key.length) throw new Error("XOR key cannot be empty");
  const output = Buffer.allocUnsafe(buffer.length);
  for (let index = 0; index < buffer.length; index += 1) output[index] = buffer[index] ^ key[index % key.length];
  return output;
}

function rc4(buffer, key) {
  if (!key.length) throw new Error("RC4 key cannot be empty");
  const state = Uint8Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let index = 0; index < 256; index += 1) {
    j = (j + state[index] + key[index % key.length]) & 255;
    [state[index], state[j]] = [state[j], state[index]];
  }
  const output = Buffer.allocUnsafe(buffer.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    output[index] = buffer[index] ^ state[(state[i] + state[j]) & 255];
  }
  return output;
}

export function transformWorkbench(inputBase64, steps, { previewBytes = 256, includeOutputBase64 = true } = {}) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 50) throw new Error("steps must contain from 1 to 50 operations");
  let current = decodeInput(inputBase64, "base64");
  const applied = [];
  for (const rawStep of steps) {
    const step = typeof rawStep === "string" ? { op: rawStep } : rawStep;
    const key = step.keyHex ? decodeInput(step.keyHex, "hex") : Buffer.from(step.key || "", "utf8");
    switch (step.op) {
      case "xor": current = xorBuffer(current, key); break;
      case "rc4": current = rc4(current, key); break;
      case "gunzip": current = bounded(gunzipSync(current, { maxOutputLength: MAX_BINARY_BYTES }), "output"); break;
      case "inflate": current = bounded(inflateSync(current, { maxOutputLength: MAX_BINARY_BYTES }), "output"); break;
      case "inflate_raw": current = bounded(inflateRawSync(current, { maxOutputLength: MAX_BINARY_BYTES }), "output"); break;
      case "base64_decode": current = decodeInput(current.toString("utf8"), "base64"); break;
      case "base64_encode": current = bounded(Buffer.from(current.toString("base64"), "utf8")); break;
      case "hex_decode": current = decodeInput(current.toString("utf8"), "hex"); break;
      case "hex_encode": current = bounded(Buffer.from(current.toString("hex"), "utf8")); break;
      default: throw new Error(`Unsupported workbench operation: ${step.op}`);
    }
    applied.push({ op: step.op, outputBytes: current.length });
  }
  const preview = current.subarray(0, Math.max(1, Math.min(previewBytes, 4_096)));
  return {
    success: true,
    applied,
    outputBytes: current.length,
    previewHex: preview.toString("hex"),
    previewUtf8: preview.toString("utf8"),
    entropy: entropy(current).entropy,
    format: detectBinaryFormat(current).format,
    ...(includeOutputBase64 ? { outputBase64: current.toString("base64") } : {}),
  };
}
