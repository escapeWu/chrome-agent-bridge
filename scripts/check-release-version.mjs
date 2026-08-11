#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tag = process.argv[2] || "";
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
const expected = tag.slice(1);

const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(root, "extension/manifest.json"), "utf8"));
const plugin = JSON.parse(await fs.readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));

const versions = {
  package: packageJson.version,
  lockfile: packageLock.version,
  lockfileRoot: packageLock.packages?.[""]?.version,
  extension: manifest.version,
  plugin: plugin.version,
};
for (const [name, version] of Object.entries(versions)) {
  if (version !== expected) throw new Error(`${name} version ${version} does not match ${tag}`);
}
process.stdout.write(`Release versions match ${tag}\n`);
