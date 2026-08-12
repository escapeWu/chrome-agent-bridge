import { createHash } from "node:crypto";
import { decodeInput } from "./binary-analysis.mjs";

const HTTP2_TYPES = ["DATA", "HEADERS", "PRIORITY", "RST_STREAM", "SETTINGS", "PUSH_PROMISE", "PING", "GOAWAY", "WINDOW_UPDATE", "CONTINUATION"];

function hexBuffer(value) {
  return decodeInput(value, "hex");
}

function readUInt24BE(buffer, offset) {
  return buffer[offset] * 0x10000 + buffer[offset + 1] * 0x100 + buffer[offset + 2];
}

export function parseHttp2Frames(inputHex) {
  const buffer = hexBuffer(inputHex);
  const frames = [];
  let offset = buffer.subarray(0, 24).toString("ascii") === "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" ? 24 : 0;
  while (offset < buffer.length) {
    if (offset + 9 > buffer.length) {
      frames.push({ offset, truncated: true, remainingHex: buffer.subarray(offset).toString("hex") });
      break;
    }
    const length = readUInt24BE(buffer, offset);
    const typeCode = buffer[offset + 3];
    const flags = buffer[offset + 4];
    const streamId = buffer.readUInt32BE(offset + 5) & 0x7fffffff;
    const payloadStart = offset + 9;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) {
      frames.push({ offset, length, typeCode, type: HTTP2_TYPES[typeCode] || "UNKNOWN", flags, streamId, truncated: true, payloadHex: buffer.subarray(payloadStart).toString("hex") });
      break;
    }
    const payload = buffer.subarray(payloadStart, payloadEnd);
    const frame = { offset, length, typeCode, type: HTTP2_TYPES[typeCode] || "UNKNOWN", flags, streamId, payloadHex: payload.toString("hex") };
    try {
      if (typeCode === 4) {
        frame.settings = [];
        for (let index = 0; index + 6 <= payload.length; index += 6) frame.settings.push({ id: payload.readUInt16BE(index), value: payload.readUInt32BE(index + 2) });
        if (payload.length % 6) frame.decodeError = "SETTINGS payload length is not divisible by 6";
      } else if (typeCode === 6 && payload.length === 8) frame.opaqueDataHex = payload.toString("hex");
      else if (typeCode === 8 && payload.length === 4) frame.windowSizeIncrement = payload.readUInt32BE(0) & 0x7fffffff;
      else if (typeCode === 3 && payload.length === 4) frame.errorCode = payload.readUInt32BE(0);
      else if (typeCode === 7 && payload.length >= 8) {
        frame.lastStreamId = payload.readUInt32BE(0) & 0x7fffffff;
        frame.errorCode = payload.readUInt32BE(4);
        frame.debugDataUtf8 = payload.subarray(8).toString("utf8");
      } else if (typeCode === 2 && payload.length === 5) {
        frame.exclusive = Boolean(payload[0] & 0x80);
        frame.streamDependency = payload.readUInt32BE(0) & 0x7fffffff;
        frame.weight = payload[4] + 1;
      }
    } catch (error) {
      frame.decodeError = error.message;
    }
    frames.push(frame);
    offset = payloadEnd;
  }
  return { success: true, byteLength: buffer.length, prefacePresent: offset >= 24 && buffer.subarray(0, 24).toString("ascii").startsWith("PRI *"), frames };
}

export function http2Fingerprint(inputHex) {
  const parsed = parseHttp2Frames(inputHex);
  const settings = parsed.frames.find((frame) => frame.type === "SETTINGS" && !(frame.flags & 1));
  const window = parsed.frames.find((frame) => frame.type === "WINDOW_UPDATE" && frame.streamId === 0);
  const priorities = parsed.frames.filter((frame) => frame.type === "PRIORITY");
  const settingsPart = (settings?.settings || []).map((item) => `${item.id}:${item.value}`).join(";");
  const priorityPart = priorities.map((item) => `${item.streamId}:${item.exclusive ? 1 : 0}:${item.streamDependency}:${item.weight}`).join(",");
  const canonical = `${settingsPart}|${window?.windowSizeIncrement || 0}|${priorityPart}`;
  return { success: true, canonical, sha256: createHash("sha256").update(canonical).digest("hex"), settings: settings?.settings || [], windowUpdate: window?.windowSizeIncrement || 0, priorities };
}

export function parseGrpcFrames(data, encoding = "base64", { strict = false } = {}) {
  const buffer = decodeInput(data, encoding);
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 5 > buffer.length) {
      if (strict) throw new Error("Truncated gRPC frame header");
      messages.push({ offset, truncated: true, remainingBase64: buffer.subarray(offset).toString("base64") });
      break;
    }
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const payloadStart = offset + 5;
    const payloadEnd = payloadStart + length;
    if (payloadEnd > buffer.length) {
      if (strict) throw new Error("Truncated gRPC frame payload");
      messages.push({ offset, flags, length, compressed: Boolean(flags & 1), isTrailer: Boolean(flags & 0x80), truncated: true, payloadBase64: buffer.subarray(payloadStart).toString("base64") });
      break;
    }
    const payload = buffer.subarray(payloadStart, payloadEnd);
    messages.push({
      offset,
      flags,
      length,
      compressed: Boolean(flags & 1),
      isTrailer: Boolean(flags & 0x80),
      payloadHex: payload.toString("hex"),
      payloadBase64: payload.toString("base64"),
      ...(flags & 0x80 ? { trailerText: payload.toString("utf8") } : {}),
    });
    offset = payloadEnd;
  }
  return { success: true, byteLength: buffer.length, messageCount: messages.length, messages };
}

export function buildGrpcFrames(messages, outputEncoding = "base64") {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > 1_000) throw new Error("messages must contain from 1 to 1000 items");
  if (!["base64", "hex"].includes(outputEncoding)) throw new Error("outputEncoding must be base64 or hex");
  let totalBytes = 0;
  const buffers = messages.map((message) => {
    if (Boolean(message.payloadHex) === Boolean(message.payloadBase64)) throw new Error("Each message requires exactly one of payloadHex or payloadBase64");
    const payload = message.payloadHex ? decodeInput(message.payloadHex, "hex") : decodeInput(message.payloadBase64 || "", "base64");
    totalBytes += 5 + payload.length;
    if (totalBytes > 8 * 1024 * 1024) throw new Error("gRPC output exceeds 8388608 bytes");
    const frame = Buffer.allocUnsafe(5 + payload.length);
    frame[0] = (message.compressed ? 1 : 0) | (message.isTrailer ? 0x80 : 0);
    frame.writeUInt32BE(payload.length, 1);
    payload.copy(frame, 5);
    return frame;
  });
  const output = Buffer.concat(buffers);
  return { success: true, byteLength: output.length, encoding: outputEncoding, data: output.toString(outputEncoding) };
}

export function fingerprintProtocol(payloadHex) {
  const buffer = hexBuffer(payloadHex);
  const ascii = buffer.subarray(0, 64).toString("ascii");
  const candidates = [];
  if (ascii.startsWith("PRI * HTTP/2.0")) candidates.push({ protocol: "http2", confidence: 1 });
  if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+\S+\s+HTTP\/1\.[01]\r?\n/.test(ascii) || /^HTTP\/1\.[01]\s+\d{3}/.test(ascii)) candidates.push({ protocol: "http1", confidence: 0.98 });
  if (buffer[0] === 0x16 && buffer[1] === 0x03 && buffer.length >= 5) candidates.push({ protocol: "tls", confidence: 0.95 });
  if (ascii.startsWith("SSH-")) candidates.push({ protocol: "ssh", confidence: 1 });
  if (buffer.length >= 12) {
    const qd = buffer.readUInt16BE(4);
    const an = buffer.readUInt16BE(6);
    if (qd <= 100 && an <= 10_000 && (buffer.readUInt16BE(2) & 0x7800) === 0) candidates.push({ protocol: "dns", confidence: 0.65 });
  }
  if ((buffer[0] & 0x80) === 0 && buffer.length >= 2 && buffer[1] <= 127) candidates.push({ protocol: "websocket-frame", confidence: 0.35 });
  candidates.sort((left, right) => right.confidence - left.confidence);
  return { success: true, protocol: candidates[0]?.protocol || "unknown", candidates };
}

export function autoDetectProtocol(samplesHex) {
  if (!Array.isArray(samplesHex) || samplesHex.length < 1 || samplesHex.length > 1_000) throw new Error("samplesHex must contain from 1 to 1000 items");
  const votes = new Map();
  const samples = samplesHex.map((sample) => fingerprintProtocol(sample));
  for (const sample of samples) for (const candidate of sample.candidates) votes.set(candidate.protocol, (votes.get(candidate.protocol) || 0) + candidate.confidence);
  const ranking = [...votes.entries()].map(([protocol, score]) => ({ protocol, score: Number(score.toFixed(3)) })).sort((a, b) => b.score - a.score);
  return { success: true, sampleCount: samplesHex.length, detected: ranking[0]?.protocol || "unknown", ranking, samples };
}

export function inferProtocolFields(samplesHex) {
  const samples = samplesHex.map(hexBuffer);
  if (samples.length < 2) throw new Error("At least two samples are required");
  if (samples.length > 1_000) throw new Error("At most 1000 samples are supported");
  const lengths = samples.map((sample) => sample.length);
  const minLength = lengths.reduce((value, length) => Math.min(value, length), Number.POSITIVE_INFINITY);
  const maxLength = lengths.reduce((value, length) => Math.max(value, length), 0);
  const fields = [];
  let start = 0;
  let currentStable = samples.every((sample) => sample[0] === samples[0][0]);
  for (let index = 1; index <= minLength; index += 1) {
    const stable = index < minLength && samples.every((sample) => sample[index] === samples[0][index]);
    if (index < minLength && stable === currentStable) continue;
    const values = samples.map((sample) => sample.subarray(start, index).toString("hex"));
    fields.push({
      offset: start,
      length: index - start,
      kind: currentStable ? "constant" : "variable",
      sampleValues: [...new Set(values)].slice(0, 20),
    });
    start = index;
    currentStable = stable;
  }
  if (maxLength > minLength) fields.push({ offset: minLength, length: maxLength - minLength, kind: "variable-tail" });
  return { success: true, sampleCount: samples.length, minLength, maxLength, fields };
}

export function inferProtocolStateMachine(messages) {
  if (!Array.isArray(messages) || messages.length === 0) throw new Error("messages is required");
  const states = new Map();
  const transitions = new Map();
  const classified = messages.map((message, index) => {
    const fingerprint = fingerprintProtocol(message.payloadHex || "").protocol;
    const direction = message.direction || "unknown";
    const prefix = (message.payloadHex || "").slice(0, 8).toLowerCase();
    const state = `${direction}:${fingerprint}:${prefix || "empty"}`;
    states.set(state, (states.get(state) || 0) + 1);
    if (index > 0) {
      const previous = messages[index - 1];
      const previousFingerprint = fingerprintProtocol(previous.payloadHex || "").protocol;
      const previousState = `${previous.direction || "unknown"}:${previousFingerprint}:${(previous.payloadHex || "").slice(0, 8).toLowerCase() || "empty"}`;
      const key = `${previousState}\u0000${state}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
    }
    return { index, state };
  });
  return {
    success: true,
    initialState: classified[0].state,
    states: [...states].map(([id, count]) => ({ id, count })),
    transitions: [...transitions].map(([key, count]) => {
      const [from, to] = key.split("\u0000");
      return { from, to, count };
    }),
    boundary: "States are deterministic clusters by direction, protocol fingerprint, and four-byte prefix.",
  };
}

export function exportProtocolSchema(name, fields) {
  const safeName = String(name || "Message").replace(/[^A-Za-z0-9_]/g, "_");
  const lines = [`message ${safeName} {`];
  fields.forEach((field, index) => {
    const type = field.type || (field.kind === "constant" ? "fixed_bytes" : "bytes");
    const fieldName = String(field.name || `field_${index + 1}`).replace(/[^A-Za-z0-9_]/g, "_");
    lines.push(`  ${type} ${fieldName} = ${index + 1}; // offset=${field.offset ?? "?"} length=${field.length ?? "?"}`);
  });
  lines.push("}");
  return { success: true, schema: lines.join("\n"), format: "proto-like" };
}

function mermaidId(value) {
  return `s_${createHash("sha1").update(value).digest("hex").slice(0, 10)}`;
}

export function visualizeProtocolState(machine) {
  const lines = ["stateDiagram-v2"];
  if (machine.initialState) lines.push(`  [*] --> ${mermaidId(machine.initialState)}`);
  for (const state of machine.states || []) lines.push(`  ${mermaidId(state.id)}: ${String(state.id).replace(/[\r\n]/g, " ")}`);
  for (const transition of machine.transitions || []) lines.push(`  ${mermaidId(transition.from)} --> ${mermaidId(transition.to)}: ${transition.count || 1}`);
  return { success: true, mermaid: lines.join("\n") };
}

function readDnsName(buffer, initialOffset, visited = new Set()) {
  let offset = initialOffset;
  let consumed = 0;
  const labels = [];
  while (offset < buffer.length) {
    if (visited.has(offset)) throw new Error("DNS compression pointer loop");
    visited.add(offset);
    const length = buffer[offset];
    if ((length & 0xc0) === 0xc0) {
      if (offset + 1 >= buffer.length) throw new Error("Truncated DNS pointer");
      const pointer = ((length & 0x3f) << 8) | buffer[offset + 1];
      const nested = readDnsName(buffer, pointer, visited);
      labels.push(nested.name);
      consumed += 2;
      return { name: labels.filter(Boolean).join("."), consumed };
    }
    if (length === 0) return { name: labels.join("."), consumed: consumed + 1 };
    if (length > 63 || offset + 1 + length > buffer.length) throw new Error("Invalid DNS label");
    labels.push(buffer.subarray(offset + 1, offset + 1 + length).toString("utf8"));
    offset += 1 + length;
    consumed += 1 + length;
  }
  throw new Error("Unterminated DNS name");
}

export function dissectDns(payloadHex) {
  const buffer = hexBuffer(payloadHex);
  if (buffer.length < 12) throw new Error("DNS payload is shorter than 12 bytes");
  const flags = buffer.readUInt16BE(2);
  const counts = { questions: buffer.readUInt16BE(4), answers: buffer.readUInt16BE(6), authority: buffer.readUInt16BE(8), additional: buffer.readUInt16BE(10) };
  let offset = 12;
  const questions = [];
  for (let index = 0; index < counts.questions; index += 1) {
    const name = readDnsName(buffer, offset);
    offset += name.consumed;
    if (offset + 4 > buffer.length) throw new Error("Truncated DNS question");
    questions.push({ name: name.name, type: buffer.readUInt16BE(offset), class: buffer.readUInt16BE(offset + 2) });
    offset += 4;
  }
  const readRecords = (count) => {
    const records = [];
    for (let index = 0; index < count; index += 1) {
      const name = readDnsName(buffer, offset);
      offset += name.consumed;
      if (offset + 10 > buffer.length) throw new Error("Truncated DNS record");
      const type = buffer.readUInt16BE(offset);
      const recordClass = buffer.readUInt16BE(offset + 2);
      const ttl = buffer.readUInt32BE(offset + 4);
      const length = buffer.readUInt16BE(offset + 8);
      offset += 10;
      if (offset + length > buffer.length) throw new Error("Truncated DNS record data");
      const data = buffer.subarray(offset, offset + length);
      offset += length;
      const record = { name: name.name, type, class: recordClass, ttl, dataHex: data.toString("hex") };
      if (type === 1 && length === 4) record.address = [...data].join(".");
      if (type === 28 && length === 16) record.address = Array.from({ length: 8 }, (_, part) => data.readUInt16BE(part * 2).toString(16)).join(":");
      records.push(record);
    }
    return records;
  };
  return {
    success: true,
    id: buffer.readUInt16BE(0),
    flags: { raw: flags, response: Boolean(flags & 0x8000), opcode: flags >> 11 & 0xf, authoritative: Boolean(flags & 0x400), truncated: Boolean(flags & 0x200), recursionDesired: Boolean(flags & 0x100), recursionAvailable: Boolean(flags & 0x80), rcode: flags & 0xf },
    counts,
    questions,
    answers: readRecords(counts.answers),
    authority: readRecords(counts.authority),
    additional: readRecords(counts.additional),
  };
}

export function dissectHttp(payload, encoding = "utf8") {
  const buffer = decodeInput(payload, encoding);
  const text = buffer.toString("latin1");
  const separator = /\r\n\r\n|\n\n/.exec(text);
  const split = separator?.index ?? -1;
  const head = split >= 0 ? text.slice(0, split) : text;
  const separatorLength = separator?.[0].length ?? 0;
  const body = split >= 0 ? buffer.subarray(Buffer.byteLength(text.slice(0, split), "latin1") + separatorLength) : Buffer.alloc(0);
  const lines = head.split(/\r?\n/);
  const startLine = lines.shift() || "";
  const headers = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
  }
  const request = /^(\S+)\s+(\S+)\s+HTTP\/(\d\.\d)$/.exec(startLine);
  const response = /^HTTP\/(\d\.\d)\s+(\d{3})(?:\s+(.*))?$/.exec(startLine);
  return {
    success: true,
    kind: request ? "request" : response ? "response" : "unknown",
    startLine,
    ...(request ? { method: request[1], target: request[2], version: request[3] } : {}),
    ...(response ? { version: response[1], status: Number(response[2]), reason: response[3] || "" } : {}),
    headers,
    bodyBytes: body.length,
    bodyBase64: body.toString("base64"),
    bodyUtf8Preview: body.subarray(0, 4_096).toString("utf8"),
  };
}
