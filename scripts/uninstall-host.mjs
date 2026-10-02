#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { bridgeDirectory, HOST_NAME } from "../lib/config.mjs";

function candidates() {
  return [
    path.join(
      os.homedir(),
      "Library/Application Support/Google/Chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
    path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "google-chrome/NativeMessagingHosts",
      `${HOST_NAME}.json`,
    ),
  ];
}

// --user-data-dir <dir> (repeatable) also removes the manifest installed there.
const userDataDirs = [];
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] !== "--user-data-dir" || !argv[index + 1]) throw new Error(`Unknown argument: ${argv[index]}`);
  userDataDirs.push(path.join(path.resolve(argv[++index]), "NativeMessagingHosts", `${HOST_NAME}.json`));
}

let removed = 0;
for (const candidate of [...candidates(), ...userDataDirs, path.join(bridgeDirectory(), "native-host-launcher")]) {
  try {
    await fs.unlink(candidate);
    process.stdout.write(`Removed ${candidate}\n`);
    removed += 1;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
if (removed === 0) process.stdout.write("No Chrome Agent Bridge native host manifest was installed.\n");
