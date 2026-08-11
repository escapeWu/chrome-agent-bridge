import assert from "node:assert/strict";
import test from "node:test";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

test("encodes and decodes one native message", () => {
  const value = { type: "response", id: "1", ok: true, result: { title: "测试" } };
  const decoder = new NativeMessageDecoder();
  assert.deepEqual(decoder.push(encodeNativeMessage(value)), [value]);
});

test("decodes fragmented input and multiple messages", () => {
  const first = encodeNativeMessage({ id: 1 });
  const second = encodeNativeMessage({ id: 2 });
  const combined = Buffer.concat([first, second]);
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(combined.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(combined.subarray(3, first.length + 2)), [{ id: 1 }]);
  assert.deepEqual(decoder.push(combined.subarray(first.length + 2)), [{ id: 2 }]);
});

test("rejects oversized native messages", () => {
  const decoder = new NativeMessageDecoder();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(4 * 1024 * 1024 + 1);
  assert.throws(() => decoder.push(header), /exceeds/);
});
