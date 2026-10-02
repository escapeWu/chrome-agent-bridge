import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("host installer dry-run emits a valid native host manifest", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "install-host.mjs"),
      "--dry-run",
    ],
  );
  const result = JSON.parse(stdout);
  assert.equal(result.manifest.type, "stdio");
  assert.equal(result.manifest.name, "com.escape_wu.chrome_agent_bridge");
  assert.deepEqual(result.manifest.allowed_origins, [
    "chrome-extension://hkedmoboloodflgcaidimhddljdnndcd/",
  ]);
  assert.ok(path.isAbsolute(result.manifest.path));
  assert.ok(path.isAbsolute(result.nodePath));
  assert.ok(path.isAbsolute(result.hostModulePath));
  assert.match(result.manifest.path, /native-host-launcher$/);
});

test("host installer dry-run accepts bind hosts and a fixed port", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      path.join(root, "scripts", "install-host.mjs"),
      "--dry-run",
      "--bind-hosts",
      "127.0.0.1,192.0.2.10",
      "--port",
      "43117",
    ],
  );
  const result = JSON.parse(stdout);
  assert.equal(result.bindHosts, "127.0.0.1,192.0.2.10");
  assert.equal(result.port, "43117");
});

test("host installer rejects an invalid bind host or port", async () => {
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        path.join(root, "scripts", "install-host.mjs"),
        "--dry-run",
        "--bind-hosts",
        "http://evil",
      ]),
  );
  await assert.rejects(
    () =>
      execFileAsync(process.execPath, [
        path.join(root, "scripts", "install-host.mjs"),
        "--dry-run",
        "--port",
        "70000",
      ]),
  );
});

test("host installer writes the manifest into each --user-data-dir and uninstall removes it", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "chrome-agent-install-"));
  context.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    CHROME_AGENT_BRIDGE_DIR: path.join(home, "bridge"),
  };
  const second = path.join(home, "chrome-second");
  const third = path.join(home, "chrome-third");
  const flags = ["--user-data-dir", second, "--user-data-dir", third];

  const dry = JSON.parse((await execFileAsync(process.execPath, [path.join(root, "scripts", "install-host.mjs"), "--dry-run", ...flags], { env })).stdout);
  assert.deepEqual(dry.extraTargets, [second, third].map((dir) => path.join(dir, "NativeMessagingHosts", "com.escape_wu.chrome_agent_bridge.json")));

  await execFileAsync(process.execPath, [path.join(root, "scripts", "install-host.mjs"), ...flags], { env });
  for (const file of [dry.target, ...dry.extraTargets]) {
    const manifest = JSON.parse(await fs.readFile(file, "utf8"));
    assert.equal(manifest.path, dry.manifest.path);
  }

  await execFileAsync(process.execPath, [path.join(root, "scripts", "uninstall-host.mjs"), ...flags], { env });
  for (const file of [dry.target, ...dry.extraTargets]) {
    await assert.rejects(fs.access(file));
  }
});
