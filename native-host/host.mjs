#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import process from "node:process";
import { bridgeDirectory, DEFAULT_TIMEOUT_MS, runtimeFile } from "../lib/config.mjs";
import { encodeNativeMessage, NativeMessageDecoder } from "../lib/native-messaging.mjs";

const token = crypto.randomBytes(32).toString("hex");
const pending = new Map();
let nextRequestId = 1;
let cleanedUp = false;

function log(message) {
  process.stderr.write(`[chrome-agent-bridge] ${message}\n`);
}

function sendNative(value) {
  process.stdout.write(encodeNativeMessage(value));
}

function serializeError(error, fallbackCode = "bridge_error") {
  return {
    code: typeof error?.code === "string" ? error.code : fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function forwardToExtension(method, params) {
  const id = String(nextRequestId++);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      const error = new Error(`Extension request timed out: ${method}`);
      error.code = "extension_timeout";
      reject(error);
    }, DEFAULT_TIMEOUT_MS);

    pending.set(id, { resolve, reject, timeout });
    sendNative({ type: "request", id, method, params });
  });
}

function handleExtensionMessage(message) {
  if (message?.type === "hello") {
    sendNative({ type: "hello", ok: true, host: "chrome-agent-bridge", version: "0.1.0" });
    return;
  }
  if (message?.type !== "response" || typeof message.id !== "string") return;

  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  clearTimeout(request.timeout);

  if (message.ok === true) request.resolve(message.result);
  else {
    const error = new Error(message?.error?.message || "Chrome extension request failed");
    error.code = message?.error?.code || "extension_error";
    request.reject(error);
  }
}

const decoder = new NativeMessageDecoder();
process.stdin.on("data", (chunk) => {
  try {
    for (const message of decoder.push(chunk)) handleExtensionMessage(message);
  } catch (error) {
    log(`Invalid native message: ${error.message}`);
    process.exitCode = 1;
    void cleanup();
  }
});

const server = http.createServer(async (request, response) => {
  response.setHeader("content-type", "application/json; charset=utf-8");

  if (request.method !== "POST" || request.url !== "/rpc") {
    response.statusCode = 404;
    response.end(JSON.stringify({ ok: false, error: { code: "not_found", message: "Not found" } }));
    return;
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.statusCode = 401;
    response.end(JSON.stringify({ ok: false, error: { code: "unauthorized", message: "Unauthorized" } }));
    return;
  }

  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) request.destroy();
  });
  request.on("end", async () => {
    try {
      const payload = JSON.parse(body);
      if (typeof payload?.method !== "string" || payload.method.length > 100) {
        const error = new Error("Invalid RPC method");
        error.code = "invalid_request";
        throw error;
      }
      const result = await forwardToExtension(payload.method, payload.params ?? {});
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.statusCode = error?.code === "invalid_request" ? 400 : 502;
      response.end(JSON.stringify({ ok: false, error: serializeError(error) }));
    }
  });
});

server.listen(0, "127.0.0.1", async () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Cannot resolve bridge address");

  const directory = bridgeDirectory();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    runtimeFile(),
    `${JSON.stringify({
      schemaVersion: 1,
      host: "127.0.0.1",
      port: address.port,
      token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
  sendNative({ type: "ready", ok: true, version: "0.1.0" });
});

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  for (const { reject, timeout } of pending.values()) {
    clearTimeout(timeout);
    reject(new Error("Native host disconnected"));
  }
  pending.clear();
  server.close();
  try {
    const current = JSON.parse(await fs.readFile(runtimeFile(), "utf8"));
    if (current?.token === token) await fs.unlink(runtimeFile());
  } catch (error) {
    if (error?.code !== "ENOENT") log(`Cleanup warning: ${error.message}`);
  }
}

process.stdin.on("end", () => void cleanup().finally(() => process.exit()));
process.on("SIGTERM", () => void cleanup().finally(() => process.exit()));
process.on("SIGINT", () => void cleanup().finally(() => process.exit()));
