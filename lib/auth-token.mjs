import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { authFile, bridgeDirectory } from "./config.mjs";

export const AUTH_SCHEMA_VERSION = 1;
export const TOKEN_PATTERN = /^cab_[A-Za-z0-9_-]{43}$/;

function createToken() {
  return `cab_${crypto.randomBytes(32).toString("base64url")}`;
}

function validateAuthState(value) {
  if (
    value?.schemaVersion !== AUTH_SCHEMA_VERSION ||
    !TOKEN_PATTERN.test(value?.token || "") ||
    typeof value?.createdAt !== "string" ||
    typeof value?.rotatedAt !== "string"
  ) {
    const error = new Error("Chrome Agent Bridge authentication file is invalid");
    error.code = "auth_file_invalid";
    throw error;
  }
  return value;
}

async function prepareDirectory(env) {
  const directory = bridgeDirectory(env);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(directory, 0o700);
  return directory;
}

async function readExistingAuthState(env) {
  const target = authFile(env);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error("Chrome Agent Bridge authentication path is not a regular file");
    error.code = "auth_file_invalid";
    throw error;
  }
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      const error = new Error("Chrome Agent Bridge authentication file is owned by another user");
      error.code = "auth_file_invalid";
      throw error;
    }
    await fs.chmod(target, 0o600);
  }
  return validateAuthState(JSON.parse(await fs.readFile(target, "utf8")));
}

async function withAuthLock(env, callback) {
  const directory = await prepareDirectory(env);
  const lockPath = path.join(directory, "auth.lock");
  const deadline = Date.now() + 5_000;
  let handle;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        const lockError = new Error("Could not acquire the authentication update lock");
        lockError.code = "auth_lock_failed";
        throw lockError;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.rm(lockPath, { force: true });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  try {
    return await callback();
  } finally {
    await handle.close();
    await fs.rm(lockPath, { force: true });
  }
}

export async function writePrivateJsonAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporary, target);
    if (process.platform !== "win32") await fs.chmod(target, 0o600);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function loadOrCreateAuthState(env = process.env) {
  await prepareDirectory(env);
  try {
    return await readExistingAuthState(env);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  return withAuthLock(env, async () => {
    try {
      return await readExistingAuthState(env);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const state = {
      schemaVersion: AUTH_SCHEMA_VERSION,
      token: createToken(),
      createdAt: now,
      rotatedAt: now,
    };
    await writePrivateJsonAtomic(authFile(env), state);
    return state;
  });
}

export async function renewAuthState(env = process.env) {
  return withAuthLock(env, async () => {
    let current;
    try {
      current = await readExistingAuthState(env);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const now = new Date().toISOString();
      current = { schemaVersion: AUTH_SCHEMA_VERSION, token: createToken(), createdAt: now, rotatedAt: now };
    }
    const state = {
      schemaVersion: AUTH_SCHEMA_VERSION,
      token: createToken(),
      createdAt: current.createdAt,
      rotatedAt: new Date().toISOString(),
    };
    await writePrivateJsonAtomic(authFile(env), state);
    return state;
  });
}

export async function readAuthToken(env = process.env) {
  const override = env.CHROME_AGENT_BRIDGE_TOKEN;
  if (override != null) {
    if (!TOKEN_PATTERN.test(override)) {
      const error = new Error("CHROME_AGENT_BRIDGE_TOKEN has an invalid format");
      error.code = "auth_token_invalid";
      throw error;
    }
    return override;
  }
  return (await loadOrCreateAuthState(env)).token;
}
