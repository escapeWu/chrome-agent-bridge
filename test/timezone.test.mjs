import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(root, "extension");
const timezone = await import(pathToFileURL(path.join(extension, "timezone.js")));
const {
  applyTimezone, buildContentScript, handleTimezoneMessage, normalizeTimezone, syncTimezone,
  TIMEZONES, TIMEZONE_FILES, TIMEZONE_SCRIPT_ID, TIMEZONE_SETTINGS_KEY, updateTimezone,
} = timezone;

function fakeChrome({ store = {}, failRegister = false } = {}) {
  const calls = [];
  let scripts = [];
  return {
    calls,
    store,
    scripting: {
      async getRegisteredContentScripts({ ids }) { return scripts.filter((script) => ids.includes(script.id)); },
      async unregisterContentScripts({ ids }) {
        calls.push(["unregister", ids]);
        scripts = scripts.filter((script) => !ids.includes(script.id));
      },
      async registerContentScripts(list) {
        if (failRegister) throw new Error("register failed");
        calls.push(["register", list]);
        scripts.push(...list);
      },
    },
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => key in store).map((key) => [key, store[key]])); },
        async set(values) { Object.assign(store, values); },
      },
    },
  };
}

test("time zone override is off by default and only accepts known zones", () => {
  assert.deepEqual(normalizeTimezone(undefined), { enabled: false, timezoneId: "america-new-york" });
  assert.deepEqual(normalizeTimezone({ enabled: "yes", timezoneId: "mars" }), { enabled: false, timezoneId: "america-new-york" });
  assert.deepEqual(normalizeTimezone({ enabled: true, timezoneId: "asia-tokyo" }), { enabled: true, timezoneId: "asia-tokyo" });
  assert.deepEqual(normalizeTimezone({ timezoneId: "__proto__" }), { enabled: false, timezoneId: "america-new-york" });
});

test("the content script is global, main-world, and every file it names exists", () => {
  const script = buildContentScript(TIMEZONES.find((zone) => zone.id === "asia-tokyo"));
  assert.equal(script.id, TIMEZONE_SCRIPT_ID);
  assert.equal(script.world, "MAIN");
  assert.equal(script.runAt, "document_start");
  assert.equal(script.allFrames, true);
  assert.deepEqual(script.matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(script.js, ["page/timezones/asia-tokyo.js", "page/timezone-spoof.js"]);
  for (const file of TIMEZONE_FILES) assert.ok(fs.existsSync(path.join(extension, file)), file);
  for (const zone of TIMEZONES) {
    const source = fs.readFileSync(path.join(extension, zone.file), "utf8");
    assert.ok(source.includes(`"${zone.timeZone}"`), zone.file);
  }
});

test("applying registers one script, replaces it on change, and removes it when off", async () => {
  const chrome = fakeChrome();
  await applyTimezone({ enabled: true, timezoneId: "utc" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["register"]);
  chrome.calls.length = 0;
  await applyTimezone({ enabled: true, timezoneId: "asia-tokyo" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["unregister", "register"]);
  chrome.calls.length = 0;
  await applyTimezone({ enabled: false, timezoneId: "asia-tokyo" }, chrome);
  assert.deepEqual(chrome.calls.map(([name]) => name), ["unregister"]);
  chrome.calls.length = 0;
  await applyTimezone({ enabled: false, timezoneId: "utc" }, chrome);
  assert.deepEqual(chrome.calls, []);
});

test("settings persist, sync re-applies them, and a failed apply is not stored", async () => {
  const chrome = fakeChrome();
  const state = await updateTimezone({ enabled: true, timezoneId: "europe-london" }, chrome);
  assert.deepEqual(state.settings, { enabled: true, timezoneId: "europe-london" });
  assert.deepEqual(chrome.store[TIMEZONE_SETTINGS_KEY], state.settings);

  chrome.calls.length = 0;
  await syncTimezone(chrome);
  assert.equal(chrome.calls.at(-1)[1][0].js[0], "page/timezones/europe-london.js");

  const failing = fakeChrome({ failRegister: true });
  await assert.rejects(updateTimezone({ enabled: true }, failing), /register failed/);
  assert.equal(TIMEZONE_SETTINGS_KEY in failing.store, false);

  await assert.rejects(handleTimezoneMessage({ type: "timezone.nope" }, chrome), { code: "method_not_found" });
  assert.equal((await handleTimezoneMessage({ type: "timezone.get" }, chrome)).zones.length, TIMEZONES.length);
});

function runSpoof(zone) {
  const context = vm.createContext({ Intl, Date });
  // vm contexts get their own Date/Intl; run against fresh builtins so tests do not leak.
  vm.runInContext("globalThis.Date = Date; globalThis.Intl = Intl;", context);
  vm.runInContext(fs.readFileSync(path.join(extension, `page/timezones/${zone}.js`), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(extension, "page/timezone-spoof.js"), "utf8"), context);
  return context;
}

test("the spoof aligns Date and Intl with the zone, including daylight saving", () => {
  const tokyo = runSpoof("asia-tokyo");
  // 2024-01-15T00:30:00Z is 09:30 on 15 January in Tokyo (UTC+9).
  const result = vm.runInContext(`(() => {
    const d = new Date("2024-01-15T00:30:00Z");
    const summer = new Date("2024-07-01T12:00:00Z");
    return {
      hours: d.getHours(), date: d.getDate(), offset: d.getTimezoneOffset(),
      day: d.getDay(), str: d.toString(), summerOffset: summer.getTimezoneOffset(),
      intl: new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23" }).format(d),
      resolved: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      explicit: new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "numeric", hourCycle: "h23" }).format(d),
      leaked: typeof globalThis.__CAB_TIMEZONE__,
    };
  })()`, tokyo);
  assert.equal(result.hours, 9);
  assert.equal(result.date, 15);
  assert.equal(result.offset, -540);
  assert.equal(result.day, 1);
  assert.match(result.str, /^Mon Jan 15 2024 09:30:00 GMT\+0900 \(/);
  assert.equal(result.summerOffset, -540);
  assert.equal(result.intl, "09");
  assert.equal(result.resolved, "Asia/Tokyo");
  assert.equal(result.explicit, "00", "an explicit timeZone option is respected");
  assert.equal(result.leaked, "undefined");

  const newYork = runSpoof("america-new-york");
  const offsets = vm.runInContext(`[
    new Date("2024-01-15T12:00:00Z").getTimezoneOffset(),
    new Date("2024-07-15T12:00:00Z").getTimezoneOffset(),
  ]`, newYork);
  assert.deepEqual([...offsets], [300, 240]);
});
