import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const regionLock = await import(pathToFileURL(path.join(extension, "features/region-lock.js")));
const {
  applyRegionLock,
  buildContentScript,
  buildHeaderRule,
  cleanOpenAiRegionPath,
  isRegionLockUrl,
  normalizeRegionLock,
  REGION_LOCK_FILES,
  REGION_LOCK_RULE_ID,
  REGION_LOCK_SCRIPT_ID,
  REGION_PROFILES,
} = regionLock;

function fakeChrome(initialScripts = []) {
  const calls = [];
  let scripts = [...initialScripts];
  return {
    calls,
    declarativeNetRequest: {
      async updateDynamicRules(options) { calls.push(["rules", options]); },
    },
    scripting: {
      async getRegisteredContentScripts({ ids }) { return scripts.filter((script) => ids.includes(script.id)); },
      async unregisterContentScripts({ ids }) {
        calls.push(["unregister", ids]);
        scripts = scripts.filter((script) => !ids.includes(script.id));
      },
      async registerContentScripts(list) {
        calls.push(["register", list]);
        scripts.push(...list);
      },
    },
  };
}

test("region lock is off by default and only offers the four US time zones", () => {
  assert.deepEqual(normalizeRegionLock(undefined), { enabled: false, profileId: "us-east" });
  assert.deepEqual(normalizeRegionLock({ enabled: "yes", profileId: "mars" }), { enabled: false, profileId: "us-east" });
  assert.deepEqual(normalizeRegionLock({ enabled: true, profileId: "us-pacific" }), { enabled: true, profileId: "us-pacific" });
  assert.deepEqual(normalizeRegionLock({ profileId: "__proto__" }), { enabled: false, profileId: "us-east" });

  assert.deepEqual(
    Object.values(REGION_PROFILES).map(({ id, timeZone, locale, acceptLanguage }) => [id, timeZone, locale, acceptLanguage]),
    [
      ["us-east", "America/New_York", "en-US", "en-US,en;q=0.9"],
      ["us-central", "America/Chicago", "en-US", "en-US,en;q=0.9"],
      ["us-mountain", "America/Denver", "en-US", "en-US,en;q=0.9"],
      ["us-pacific", "America/Los_Angeles", "en-US", "en-US,en;q=0.9"],
    ],
  );
});

test("the request-language rule covers navigations and both OpenAI domains", () => {
  const rule = buildHeaderRule(REGION_PROFILES["us-central"]);
  assert.equal(rule.id, REGION_LOCK_RULE_ID);
  assert.deepEqual(rule.action, {
    type: "modifyHeaders",
    requestHeaders: [{ header: "accept-language", operation: "set", value: "en-US,en;q=0.9" }],
  });
  assert.deepEqual(rule.condition.requestDomains, ["openai.com", "chatgpt.com"]);
  // A rule without resourceTypes skips main_frame, the request that picks the locale.
  assert.ok(rule.condition.resourceTypes.includes("main_frame"));
  assert.ok(rule.condition.resourceTypes.includes("xmlhttprequest"));
});

test("the main-world script runs the profile first and covers subframes", () => {
  const script = buildContentScript(REGION_PROFILES["us-mountain"]);
  assert.equal(script.id, REGION_LOCK_SCRIPT_ID);
  assert.equal(script.world, "MAIN");
  assert.equal(script.runAt, "document_start");
  assert.deepEqual(script.js, ["features/page/profiles/us-mountain.js", "features/page/region-spoof.js"]);
  assert.ok(script.matches.includes("https://chatgpt.com/*"));
  assert.ok(script.matches.includes("https://*.openai.com/*"));
  for (const file of REGION_LOCK_FILES) assert.ok(fs.existsSync(path.join(extension, file)), file);
});

test("applying the region lock registers one rule and one script, and removes them when off", async () => {
  const chrome = fakeChrome();
  await applyRegionLock({ enabled: true, profileId: "us-east" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["rules", "register"]);
  assert.equal(chrome.calls[0][1].addRules[0].id, REGION_LOCK_RULE_ID);
  assert.deepEqual(chrome.calls[0][1].removeRuleIds, [REGION_LOCK_RULE_ID]);

  // Switching profile replaces the registration instead of adding a second one.
  chrome.calls.length = 0;
  await applyRegionLock({ enabled: true, profileId: "us-pacific" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["rules", "unregister", "register"]);
  assert.deepEqual(chrome.calls[2][1][0].js[0], "features/page/profiles/us-pacific.js");

  chrome.calls.length = 0;
  await applyRegionLock({ enabled: false, profileId: "us-pacific" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["rules", "unregister"]);
  assert.deepEqual(chrome.calls[0][1].addRules, []);

  // Turning it off when nothing is registered only clears the rule.
  chrome.calls.length = 0;
  await applyRegionLock({ enabled: false, profileId: "us-east" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["rules"]);
});

test("the /zh-Hans-CN cleanup only rewrites the apex openai.com path", () => {
  assert.equal(cleanOpenAiRegionPath("https://openai.com/zh-Hans-CN/"), "https://openai.com/");
  assert.equal(cleanOpenAiRegionPath("https://openai.com/zh-Hans-CN"), "https://openai.com/");
  assert.equal(cleanOpenAiRegionPath("https://openai.com/zh-Hans-CN/research/gpt?x=1#top"), "https://openai.com/research/gpt?x=1#top");
  assert.equal(cleanOpenAiRegionPath("https://openai.com/research"), null);
  assert.equal(cleanOpenAiRegionPath("https://openai.com/zh-Hans-CNx/a"), null);
  assert.equal(cleanOpenAiRegionPath("https://www.openai.com/zh-Hans-CN/"), null);
  assert.equal(cleanOpenAiRegionPath("https://chatgpt.com/zh-Hans-CN/"), null);
  assert.equal(cleanOpenAiRegionPath("http://openai.com/zh-Hans-CN/"), null);
  assert.equal(cleanOpenAiRegionPath("not a url"), null);

  assert.equal(isRegionLockUrl("https://chatgpt.com/c/1"), true);
  assert.equal(isRegionLockUrl("https://auth.openai.com/log-in"), true);
  assert.equal(isRegionLockUrl("https://notopenai.com/"), false);
  assert.equal(isRegionLockUrl("https://openai.com.evil.example/"), false);
  assert.equal(isRegionLockUrl("http://chatgpt.com/"), false);
});

function pageContext(profileId, { documentElement = {} } = {}) {
  class Navigator {
    get language() { return "zh-CN"; }
    get languages() { return ["zh-CN", "zh"]; }
  }
  const sandbox = { navigator: new Navigator(), document: { documentElement } };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);
  const run = (file) => vm.runInContext(fs.readFileSync(path.join(extension, file), "utf8"), context, { filename: file });
  run(`features/page/profiles/${profileId}.js`);
  run("features/page/region-spoof.js");
  return { context, sandbox, run, evaluate: (code) => vm.runInContext(code, context) };
}

test("the page script aligns language, Intl and Date with the profile, including daylight saving", () => {
  const { sandbox, evaluate } = pageContext("us-east");
  assert.equal(sandbox.navigator.language, "en-US");
  assert.deepEqual([...sandbox.navigator.languages], ["en-US", "en"]);
  assert.equal(sandbox.document.documentElement.lang, "en-US");
  assert.equal(evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), "America/New_York");
  assert.equal(evaluate("new Intl.DateTimeFormat().resolvedOptions().locale"), "en-US");

  // Winter (EST) and summer (EDT).
  assert.equal(evaluate('new Date("2026-01-15T12:00:00Z").getTimezoneOffset()'), 300);
  assert.equal(evaluate('new Date("2026-07-15T12:00:00Z").getTimezoneOffset()'), 240);
  assert.equal(evaluate('new Date("2026-01-15T12:00:00Z").getHours()'), 7);
  assert.equal(evaluate('new Date("2026-07-15T12:00:00Z").getHours()'), 8);
  assert.equal(evaluate('new Date("2026-01-15T03:30:00Z").getDate()'), 14);
  assert.equal(evaluate('new Date("2026-01-15T03:30:00Z").getDay()'), 3);
  assert.equal(
    evaluate('new Date("2026-01-15T12:00:00Z").toString()'),
    "Thu Jan 15 2026 07:00:00 GMT-0500 (Eastern Standard Time)",
  );
  // Some ICU versions put a narrow no-break space before AM/PM.
  assert.equal(evaluate('new Date("2026-01-15T12:00:00Z").toLocaleString()').replace(/\s/g, " "), "1/15/2026, 7:00:00 AM");
  // An explicit time zone from the page still wins.
  assert.equal(
    evaluate('new Date("2026-01-15T12:00:00Z").toLocaleTimeString("en-US", { timeZone: "UTC" })').replace(/\s/g, " "),
    "12:00:00 PM",
  );
  assert.equal(evaluate("new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat"), true);
  assert.ok(Number.isNaN(evaluate("new Date(NaN).getHours()")));
  assert.equal(evaluate("new Date(NaN).toString()"), "Invalid Date");
});

test("each profile reports its own zone and the profile global leaves no trace", () => {
  const expected = {
    "us-central": [360, "America/Chicago"],
    "us-mountain": [420, "America/Denver"],
    "us-pacific": [480, "America/Los_Angeles"],
  };
  for (const [profileId, [offset, zone]] of Object.entries(expected)) {
    const { evaluate } = pageContext(profileId);
    assert.equal(evaluate('new Date("2026-01-15T12:00:00Z").getTimezoneOffset()'), offset, profileId);
    assert.equal(evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), zone, profileId);
    assert.equal(evaluate('typeof globalThis.__CAB_REGION_PROFILE__'), "undefined");
  }
});

test("running the page script twice does not stack wrappers, and no profile means no change", () => {
  const { run, evaluate } = pageContext("us-pacific");
  const before = evaluate("Intl.DateTimeFormat");
  run("features/page/profiles/us-east.js");
  run("features/page/region-spoof.js");
  assert.equal(evaluate("Intl.DateTimeFormat"), before);
  assert.equal(evaluate("Intl.DateTimeFormat().resolvedOptions().timeZone"), "America/Los_Angeles");

  class Navigator { get language() { return "zh-CN"; } }
  const sandbox = { navigator: new Navigator(), document: { documentElement: {} } };
  sandbox.globalThis = sandbox;
  vm.runInContext(
    fs.readFileSync(path.join(extension, "features/page/region-spoof.js"), "utf8"),
    vm.createContext(sandbox),
  );
  assert.equal(sandbox.navigator.language, "zh-CN");
});
