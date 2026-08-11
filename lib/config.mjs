import os from "node:os";
import path from "node:path";

export const HOST_NAME = "com.escape_wu.chrome_agent_bridge";
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_NATIVE_MESSAGE_BYTES = 4 * 1024 * 1024;

export function bridgeDirectory(env = process.env) {
  return path.resolve(
    env.CHROME_AGENT_BRIDGE_DIR || path.join(os.homedir(), ".chrome-agent-bridge"),
  );
}

export function runtimeFile(env = process.env) {
  return path.join(bridgeDirectory(env), "runtime.json");
}
