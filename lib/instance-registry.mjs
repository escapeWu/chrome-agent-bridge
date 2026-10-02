import fs from "node:fs/promises";
import { writePrivateJsonAtomic } from "./auth-token.mjs";
import { instanceFile, instancesDirectory, isValidHost } from "./config.mjs";

export const INSTANCE_SCHEMA_VERSION = 3;
export const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
export const SESSION_PREFIX_SEPARATOR = "~";
const SESSION_PREFIX_PATTERN = /^([A-Za-z0-9_-]{4,64})~(.+)$/s;
const MAX_LABEL_LENGTH = 64;

export function isValidInstanceId(value) {
  return typeof value === "string" && INSTANCE_ID_PATTERN.test(value);
}

export function defaultInstanceLabel(instanceId) {
  return `Chrome-${instanceId.replace(/^inst_/, "").slice(-4)}`;
}

/** Trim, drop control characters, and bound a user-supplied browser label. */
export function normalizeLabel(value, instanceId) {
  const cleaned = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_LABEL_LENGTH)
    : "";
  return cleaned || defaultInstanceLabel(instanceId);
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function validateRecord(value) {
  if (
    value?.schemaVersion !== INSTANCE_SCHEMA_VERSION ||
    !isValidInstanceId(value.instanceId) ||
    !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    !Number.isInteger(value.pid) ||
    !isValidHost(value.host)
  ) {
    return null;
  }
  return {
    ...value,
    label: normalizeLabel(value.label, value.instanceId),
    hosts: Array.isArray(value.hosts) ? value.hosts.filter(isValidHost) : [value.host],
  };
}

export async function writeInstanceRecord(record, env = process.env) {
  await fs.mkdir(instancesDirectory(env), { recursive: true, mode: 0o700 });
  await writePrivateJsonAtomic(instanceFile(record.instanceId, env), {
    ...record,
    schemaVersion: INSTANCE_SCHEMA_VERSION,
  });
}

export async function readInstanceRecord(instanceId, env = process.env) {
  if (!isValidInstanceId(instanceId)) return null;
  try {
    return validateRecord(JSON.parse(await fs.readFile(instanceFile(instanceId, env), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

/** Remove a record, but only when it still belongs to the given process. */
export async function removeInstanceRecord(instanceId, pid, env = process.env) {
  const current = await readInstanceRecord(instanceId, env);
  if (current && current.pid !== pid) return false;
  try {
    await fs.unlink(instanceFile(instanceId, env));
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Registered browser instances whose native host process is still running.
 * Records left behind by a crashed host are pruned as a side effect.
 */
export async function listInstances(env = process.env) {
  let names;
  try {
    names = await fs.readdir(instancesDirectory(env));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const instances = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const instanceId = name.slice(0, -".json".length);
    const record = await readInstanceRecord(instanceId, env).catch(() => null);
    if (!record) continue;
    if (!isProcessAlive(record.pid)) {
      await removeInstanceRecord(instanceId, record.pid, env).catch(() => {});
      continue;
    }
    instances.push(record);
  }
  return instances.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

function routeError(code, message, instances) {
  const error = new Error(message);
  error.code = code;
  error.instances = instances.map(describeInstance);
  return error;
}

export function describeInstance(record) {
  return { instanceId: record.instanceId, label: record.label };
}

/**
 * Pick one instance. Order: an explicit selector (instance ID or label), then
 * the only registered instance. Several instances with no selector is an error
 * rather than a guess, so an action never lands in the wrong signed-in browser.
 */
export function selectInstance(instances, selector) {
  if (instances.length === 0) {
    throw routeError("browser_not_found", "No Chrome Agent Bridge browser instance is registered", instances);
  }
  if (selector == null || selector === "") {
    if (instances.length === 1) return instances[0];
    throw routeError(
      "browser_ambiguous",
      `${instances.length} browsers are connected; pass "browser" with an instanceId or label from browser_list_instances`,
      instances,
    );
  }
  const byId = instances.find((record) => record.instanceId === selector);
  if (byId) return byId;
  const wanted = String(selector).trim().toLowerCase();
  const byLabel = instances.filter((record) => record.label.toLowerCase() === wanted);
  if (byLabel.length === 1) return byLabel[0];
  if (byLabel.length > 1) {
    throw routeError("browser_ambiguous", `Several browsers share the label "${selector}"; use an instanceId`, byLabel);
  }
  throw routeError("browser_not_found", `No connected browser matches "${selector}"`, instances);
}

export function prefixSessionId(instanceId, sessionId) {
  return `${instanceId}${SESSION_PREFIX_SEPARATOR}${sessionId}`;
}

/** Split `<instanceId>~<sessionId>`; unprefixed values return a null instanceId. */
export function splitSessionId(value) {
  if (typeof value !== "string") return { instanceId: null, sessionId: value };
  const match = SESSION_PREFIX_PATTERN.exec(value);
  return match ? { instanceId: match[1], sessionId: match[2] } : { instanceId: null, sessionId: value };
}
