import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("popup masks long-lived tokens and never uses synchronized storage", async () => {
  const module = await import(pathToFileURL(path.join(root, "extension/popup.js")));
  const token = `cab_${Buffer.alloc(32, 3).toString("base64url")}`;
  const masked = module.maskToken(token);
  assert.equal(masked.startsWith(token.slice(0, 8)), true);
  assert.equal(masked.endsWith(token.slice(-6)), true);
  assert.equal(masked.includes(token), false);

  const source = await fs.readFile(path.join(root, "extension/popup.js"), "utf8");
  assert.equal(source.includes("storage.sync"), false);
  assert.equal(source.includes("console."), false);
});
