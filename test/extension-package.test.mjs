import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("release ZIP contains only the load-unpacked extension at archive root", async (context) => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-package-test-"));
  context.after(() => fs.rm(output, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(root, "scripts/build-extension-zip.mjs"),
    "--out-dir",
    output,
  ]);
  const archive = stdout.trim();
  const { stdout: listing } = await execFileAsync("unzip", ["-Z1", archive]);
  const entries = listing.trim().split("\n").sort();
  assert.equal(entries.includes("manifest.json"), true);
  assert.equal(entries.includes("service-worker.js"), true);
  assert.equal(entries.includes("popup.html"), true);
  assert.equal(entries.some((entry) => /(^|\/)(node_modules|work|dist|\.git)(\/|$)/.test(entry)), false);
  assert.equal(entries.some((entry) => /\.(pem|env)$/i.test(entry)), false);
});
