import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("extension manifest requests only the documented capability set", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "extension", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), [
    "activeTab",
    "nativeMessaging",
    "scripting",
    "tabs",
  ]);
  assert.equal(manifest.permissions.includes("cookies"), false);
  assert.equal(manifest.permissions.includes("history"), false);
  assert.equal(manifest.permissions.includes("debugger"), false);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
});
