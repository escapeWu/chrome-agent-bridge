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
const script = path.join(root, "scripts", "bump-version.mjs");
const files = ["package.json", "package-lock.json", "extension/manifest.json", ".codex-plugin/plugin.json"];

async function fixture(context) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-bump-"));
  context.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dir, file));
    // Keep the copies on a known version regardless of the repository's.
    const data = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    data.version = "1.2.3";
    if (data.packages?.[""]) data.packages[""].version = "1.2.3";
    await fs.writeFile(path.join(dir, file), JSON.stringify(data, null, 2));
  }
  return dir;
}

test("bump-version updates every release manifest", async (context) => {
  const dir = await fixture(context);
  const { stdout } = await execFileAsync(process.execPath, [script, "minor", "--root", dir]);
  assert.equal(stdout.trim(), "1.3.0");
  for (const file of files) {
    const data = JSON.parse(await fs.readFile(path.join(dir, file), "utf8"));
    assert.equal(data.version, "1.3.0", file);
    if (data.packages?.[""]) assert.equal(data.packages[""].version, "1.3.0");
  }
});

test("bump-version supports patch, major, explicit versions, and rejects junk", async (context) => {
  const dir = await fixture(context);
  const run = async (request) => (await execFileAsync(process.execPath, [script, request, "--root", dir])).stdout.trim();
  assert.equal(await run("patch"), "1.2.4");
  assert.equal(await run("major"), "2.0.0");
  assert.equal(await run("0.9.0"), "0.9.0");
  await assert.rejects(run("v1.0.0"), /Pass patch, minor, major/);
  await assert.rejects(run("latest"), /Pass patch, minor, major/);
});

test("source files read the version from package.json instead of a literal", async () => {
  const { VERSION } = await import("../lib/version.mjs");
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(VERSION, pkg.version);
  for (const file of ["mcp/create-server.mjs", "native-host/host.mjs", "lib/cdp-analysis.mjs"]) {
    assert.equal(/version:\s*"\d+\.\d+\.\d+"/.test(await fs.readFile(path.join(root, file), "utf8")), false, file);
  }
});
