import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillDir = path.join(root, "skills", "chrome-agent-control");
const referencesDir = path.join(skillDir, "references");

test("chrome-agent-control uses scenario-scoped progressive references", () => {
  const expectedReferences = [
    "code-analysis.md",
    "connection-and-recovery.md",
    "network-monitoring.md",
    "page-control.md",
    "performance-and-deep-network.md",
    "protocol-and-wasm.md",
    "raw-cdp.md",
    "script-debugging.md",
    "source-maps.md",
  ];
  const skill = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
  const linkedReferences = [...skill.matchAll(/\(references\/([^)]+\.md)\)/g)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(linkedReferences, expectedReferences);
  assert.equal(fs.existsSync(path.join(referencesDir, "tool-contract.md")), false);
  assert.ok(skill.split("\n").length <= 80, "SKILL.md should remain a routing layer");

  for (const filename of expectedReferences) {
    const content = fs.readFileSync(path.join(referencesDir, filename), "utf8");
    assert.ok(content.split("\n").length <= 100, `${filename} should remain independently scannable`);
  }
});
