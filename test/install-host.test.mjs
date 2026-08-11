import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host installer dry-run emits a valid native host manifest", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "install-host.mjs"),
      "--extension-id",
      "abcdefghijklmnopabcdefghijklmnop",
      "--dry-run",
    ],
  );
  const result = JSON.parse(stdout);
  assert.equal(result.manifest.type, "stdio");
  assert.equal(result.manifest.name, "com.escape_wu.chrome_agent_bridge");
  assert.deepEqual(result.manifest.allowed_origins, [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/",
  ]);
  assert.ok(path.isAbsolute(result.manifest.path));
});
