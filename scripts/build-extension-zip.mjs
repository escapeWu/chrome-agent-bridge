#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, "manifest.json"), "utf8"));

if (manifest.version !== packageJson.version) {
  throw new Error(`Version mismatch: extension=${manifest.version}, package=${packageJson.version}`);
}

const allowedFiles = [
  "manifest.json",
  "service-worker.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "icons/icon16.png",
  "icons/icon32.png",
  "icons/icon48.png",
  "icons/icon128.png",
];

function parseOutputDirectory(argv) {
  const index = argv.indexOf("--out-dir");
  if (index === -1) return path.join(root, "dist");
  const value = argv[index + 1];
  if (!value) throw new Error("--out-dir requires a path");
  return path.resolve(value);
}

const outputDirectory = parseOutputDirectory(process.argv.slice(2));
const stagingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-extension-"));
const archive = path.join(
  outputDirectory,
  `chrome-agent-bridge-extension-v${manifest.version}.zip`,
);

try {
  for (const relativePath of allowedFiles) {
    const source = path.join(extensionRoot, relativePath);
    const stat = await fs.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Extension package entry is not a regular file: ${relativePath}`);
    }
    const destination = path.join(stagingDirectory, relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }

  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.rm(archive, { force: true });
  await execFileAsync("zip", ["-X", "-q", "-D", archive, ...allowedFiles], {
    cwd: stagingDirectory,
  });
  process.stdout.write(`${archive}\n`);
} finally {
  await fs.rm(stagingDirectory, { recursive: true, force: true });
}
