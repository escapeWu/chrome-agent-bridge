import { MAX_NATIVE_MESSAGE_BYTES } from "./config.mjs";

export function encodeNativeMessage(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export class NativeMessageDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages = [];

    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) {
        throw new Error(`Native message exceeds ${MAX_NATIVE_MESSAGE_BYTES} bytes`);
      }
      if (this.#buffer.length < length + 4) break;

      const body = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      messages.push(JSON.parse(body.toString("utf8")));
    }

    return messages;
  }
}
