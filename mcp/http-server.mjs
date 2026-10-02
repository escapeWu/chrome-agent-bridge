#!/usr/bin/env node
/**
 * URL (Streamable HTTP) entry for Chrome Agent Bridge.
 *
 * Exposes the exact same MCP tool surface as `server.mjs`, but over HTTP so a
 * remote MCP client can connect with a URL instead of a local stdio command.
 * Every MCP request must carry `Authorization: Bearer <token>`.
 *
 * Configuration:
 *   CHROME_AGENT_BRIDGE_MCP_HOST   bind address(es), comma separated
 *                                  (default 127.0.0.1; `0.0.0.0` or `::` binds all)
 *   CHROME_AGENT_BRIDGE_MCP_PORT   bind port           (default 43118)
 *   CHROME_AGENT_BRIDGE_MCP_PATH   endpoint path       (default /mcp)
 *   CHROME_AGENT_BRIDGE_MCP_TOKEN  optional fixed bearer token override
 *
 * Token: by default there is ONE token, the bridge token in auth.json (shown in
 * the extension popup). It is read on every request, so Renew in the popup takes
 * effect immediately for MCP clients and for the internal call to the native host.
 * Setting CHROME_AGENT_BRIDGE_MCP_TOKEN pins a separate client-facing token that
 * does not follow Renew.
 */
import crypto, { webcrypto } from "node:crypto";
import http from "node:http";
import process from "node:process";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readAuthToken } from "../lib/auth-token.mjs";
import {
  formatHostForUrl,
  isLoopbackHost,
  isValidHost,
  isWildcardHost,
  parseHostList,
} from "../lib/config.mjs";
import { createBridgeServer } from "./create-server.mjs";

// Node 18 has no global `crypto`, which the SDK's Streamable HTTP transport uses.
globalThis.crypto ??= webcrypto;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function log(message) {
  process.stderr.write(`[chrome-agent-bridge-mcp] ${message}\n`);
}

function resolveHosts() {
  const list = parseHostList(process.env.CHROME_AGENT_BRIDGE_MCP_HOST);
  if (list.length === 0) return ["127.0.0.1"];
  for (const host of list) {
    if (!isValidHost(host)) throw new Error(`CHROME_AGENT_BRIDGE_MCP_HOST is invalid: ${host}`);
  }
  // A wildcard bind already covers every interface, so it is never combined
  // with per-address sockets (which would collide with EADDRINUSE).
  const wildcard = list.find(isWildcardHost);
  if (wildcard) return [wildcard];
  return [...new Set(list)];
}

function resolvePort() {
  const raw = process.env.CHROME_AGENT_BRIDGE_MCP_PORT;
  if (raw == null || raw.trim() === "") return 43118;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("CHROME_AGENT_BRIDGE_MCP_PORT must be an integer from 1 to 65535");
  }
  return port;
}

function resolvePath() {
  const raw = process.env.CHROME_AGENT_BRIDGE_MCP_PATH;
  if (raw == null || raw.trim() === "") return "/mcp";
  const value = raw.trim();
  return value.startsWith("/") ? value : `/${value}`;
}

function explicitToken() {
  const explicit = process.env.CHROME_AGENT_BRIDGE_MCP_TOKEN;
  return explicit != null && explicit.trim() !== "" ? explicit.trim() : null;
}

/** The token a client must present right now. */
async function currentToken() {
  return explicitToken() ?? readAuthToken();
}

function isAuthorized(header, expectedToken) {
  const prefix = "Bearer ";
  const provided =
    typeof header === "string" && header.startsWith(prefix) ? header.slice(prefix.length) : "";
  const expectedBuffer = Buffer.from(expectedToken);
  const providedBuffer = Buffer.from(provided);
  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        const error = new Error("Request body too large");
        error.code = "payload_too_large";
        request.destroy();
        reject(error);
      }
    });
    request.on("end", () => {
      if (body.trim() === "") return resolve(undefined);
      try {
        resolve(JSON.parse(body));
      } catch {
        const error = new Error("Request body is not valid JSON");
        error.code = "invalid_json";
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

const hosts = resolveHosts();
const port = resolvePort();
const endpointPath = resolvePath();
// Fail at startup (and create auth.json on first run) rather than on a request.
await currentToken();

async function handleMcp(request, response) {
  // Stateless Streamable HTTP: one transport + server per request. The browser
  // bridge is itself stateless, so no session affinity is required.
  const server = createBridgeServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  response.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    const body = await readJsonBody(request);
    await transport.handleRequest(request, response, body);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, error?.code === "payload_too_large" ? 413 : 400, {
        jsonrpc: "2.0",
        error: { code: -32700, message: error.message },
        id: null,
      });
    } else {
      response.end();
    }
  }
}

async function requestHandler(request, response) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "chrome-agent-bridge-mcp" });
    return;
  }

  if (url.pathname !== endpointPath) {
    sendJson(response, 404, { error: { code: "not_found", message: "Not found" } });
    return;
  }

  let token;
  try {
    token = await currentToken();
  } catch (error) {
    log(`Cannot read the bridge token: ${error.message}`);
    sendJson(response, 503, { error: { code: "auth_unavailable", message: "Authentication is unavailable" } });
    return;
  }
  if (!isAuthorized(request.headers.authorization, token)) {
    response.setHeader("www-authenticate", 'Bearer realm="chrome-agent-bridge-mcp"');
    sendJson(response, 401, { error: { code: "unauthorized", message: "Unauthorized" } });
    return;
  }

  if (request.method === "POST") {
    await handleMcp(request, response);
    return;
  }

  // Stateless mode has no server-to-client SSE stream or session to delete.
  response.setHeader("allow", "POST");
  sendJson(response, 405, { error: { code: "method_not_allowed", message: "Use POST" } });
}

log(
  explicitToken()
    ? "Token: CHROME_AGENT_BRIDGE_MCP_TOKEN override (does not follow Renew)"
    : "Token: auth.json, read per request (follows Renew in the extension popup)",
);

const servers = [];
await Promise.all(
  hosts.map(
    (host) =>
      new Promise((resolve) => {
        const server = http.createServer(requestHandler);
        server.once("error", (error) => {
          log(`Could not bind ${host}:${port}: ${error.message}`);
          server.close();
          resolve();
        });
        server.listen(port, host, () => {
          servers.push(server);
          log(`URL MCP listening on http://${formatHostForUrl(host)}:${port}${endpointPath} (Bearer token required)`);
          if (!isLoopbackHost(host) && !isWildcardHost(host)) {
            log(`WARNING: MCP endpoint is reachable at ${host}:${port}; the bearer token is required.`);
          }
          resolve();
        });
      }),
  ),
);

if (servers.length === 0) {
  log("Failed to bind any Chrome Agent Bridge MCP address");
  process.exit(1);
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    let remaining = servers.length;
    for (const server of servers) {
      server.close(() => {
        remaining -= 1;
        if (remaining === 0) process.exit(0);
      });
    }
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
