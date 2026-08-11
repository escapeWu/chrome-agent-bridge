import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EXTENSION_ID } from "../lib/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("extension manifest requests only the documented capability set", async () => {
  const manifest = JSON.parse(
    await fs.readFile(path.join(root, "extension", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  const id = [...crypto.createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
  assert.equal(id, EXTENSION_ID);
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

  const expectedIcons = {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  };
  assert.deepEqual(manifest.icons, expectedIcons);
  assert.deepEqual(manifest.action.default_icon, expectedIcons);
  assert.equal(manifest.action.default_popup, "popup.html");

  await Promise.all(
    [...Object.values(expectedIcons), "popup.html", "popup.css", "popup.js"].map(
      (filePath) => fs.access(path.join(root, "extension", filePath)),
    ),
  );
});
