import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadOrCreateAuthState,
  readAuthToken,
  renewAuthState,
  TOKEN_PATTERN,
} from "../lib/auth-token.mjs";

test("authentication token persists locally until explicitly renewed", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-auth-test-"));
  const env = { CHROME_AGENT_BRIDGE_DIR: directory };
  context.after(() => fs.rm(directory, { recursive: true, force: true }));

  const first = await loadOrCreateAuthState(env);
  const second = await loadOrCreateAuthState(env);
  assert.match(first.token, TOKEN_PATTERN);
  assert.equal(second.token, first.token);
  assert.equal(await readAuthToken(env), first.token);

  const renewed = await renewAuthState(env);
  assert.match(renewed.token, TOKEN_PATTERN);
  assert.notEqual(renewed.token, first.token);
  assert.equal(renewed.createdAt, first.createdAt);
  assert.equal((await loadOrCreateAuthState(env)).token, renewed.token);

  if (process.platform !== "win32") {
    const stat = await fs.stat(path.join(directory, "auth.json"));
    assert.equal(stat.mode & 0o777, 0o600);
  }
});

test("environment token overrides the local token without persisting it", async () => {
  const token = `cab_${Buffer.alloc(32, 7).toString("base64url")}`;
  assert.equal(await readAuthToken({ CHROME_AGENT_BRIDGE_TOKEN: token }), token);
});
