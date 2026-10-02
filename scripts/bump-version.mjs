#!/usr/bin/env node
/**
 * Set the release version everywhere check-release-version.mjs expects it.
 *
 *   node scripts/bump-version.mjs <patch|minor|major|X.Y.Z> [--root DIR]
 *
 * Prints the new version. Source code reads lib/version.mjs, so only the
 * manifests below carry a literal version.
 */
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const rootIndex = args.indexOf("--root");
const root = rootIndex === -1
  ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  : path.resolve(args.splice(rootIndex, 2)[1] ?? "");
const request = args[0] ?? "";

async function readJson(relativePath) {
  return JSON.parse(await fs.readFile(path.join(root, relativePath), "utf8"));
}

async function writeJson(relativePath, value) {
  await fs.writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

export function nextVersion(current, request) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!match) throw new Error(`Current version is not X.Y.Z: ${current}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (request === "major") return `${major + 1}.0.0`;
  if (request === "minor") return `${major}.${minor + 1}.0`;
  if (request === "patch") return `${major}.${minor}.${patch + 1}`;
  if (/^\d+\.\d+\.\d+$/.test(request)) return request;
  throw new Error(`Pass patch, minor, major, or an explicit X.Y.Z (got "${request}")`);
}

const packageJson = await readJson("package.json");
const version = nextVersion(packageJson.version, request);

packageJson.version = version;
await writeJson("package.json", packageJson);

const lock = await readJson("package-lock.json");
lock.version = version;
if (lock.packages?.[""]) lock.packages[""].version = version;
await writeJson("package-lock.json", lock);

for (const file of ["extension/manifest.json", ".codex-plugin/plugin.json"]) {
  const manifest = await readJson(file);
  manifest.version = version;
  await writeJson(file, manifest);
}

process.stdout.write(`${version}\n`);
