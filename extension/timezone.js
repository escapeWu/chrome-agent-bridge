// Optional global time-zone override (off by default, switched only from the popup).
//
// When on, a main-world content script at document_start makes Date and
// Intl.DateTimeFormat report the chosen time zone on every http(s) page and frame.
// It is a JavaScript-level override: it does not change the operating system or
// Chrome profile time zone, and it does not touch language, cookies or the IP address.
// Settings live in chrome.storage.local and are re-applied on install, update and
// browser start so Chrome's registrations always match them.

export const TIMEZONE_SETTINGS_KEY = "timezoneSettings";
export const TIMEZONE_SCRIPT_ID = "chrome-agent-bridge-timezone";
export const TIMEZONE_SPOOF_FILE = "page/timezone-spoof.js";
export const TIMEZONE_MATCHES = Object.freeze(["http://*/*", "https://*/*"]);
export const DEFAULT_TIMEZONE_ID = "america-new-york";

function tz(id, label, timeZone) {
  return Object.freeze({ id, label, timeZone, file: `page/timezones/${id}.js` });
}

export const TIMEZONES = Object.freeze([
  tz("utc", "UTC", "UTC"),
  tz("america-new-york", "US Eastern", "America/New_York"),
  tz("america-chicago", "US Central", "America/Chicago"),
  tz("america-denver", "US Mountain", "America/Denver"),
  tz("america-los-angeles", "US Pacific", "America/Los_Angeles"),
  tz("america-sao-paulo", "Brazil (São Paulo)", "America/Sao_Paulo"),
  tz("europe-london", "London", "Europe/London"),
  tz("europe-paris", "Central Europe (Paris)", "Europe/Paris"),
  tz("europe-moscow", "Moscow", "Europe/Moscow"),
  tz("asia-dubai", "Dubai", "Asia/Dubai"),
  tz("asia-kolkata", "India (Kolkata)", "Asia/Kolkata"),
  tz("asia-shanghai", "China (Shanghai)", "Asia/Shanghai"),
  tz("asia-tokyo", "Japan (Tokyo)", "Asia/Tokyo"),
  tz("asia-singapore", "Singapore", "Asia/Singapore"),
  tz("australia-sydney", "Sydney", "Australia/Sydney"),
  tz("pacific-auckland", "New Zealand (Auckland)", "Pacific/Auckland"),
]);

const BY_ID = new Map(TIMEZONES.map((zone) => [zone.id, zone]));

/** Every extension file the override needs; the release ZIP must contain all of them. */
export const TIMEZONE_FILES = Object.freeze([TIMEZONE_SPOOF_FILE, ...TIMEZONES.map((zone) => zone.file)]);

export function normalizeTimezone(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    enabled: candidate.enabled === true,
    timezoneId: typeof candidate.timezoneId === "string" && BY_ID.has(candidate.timezoneId)
      ? candidate.timezoneId
      : DEFAULT_TIMEZONE_ID,
  };
}

export function buildContentScript(zone) {
  return {
    id: TIMEZONE_SCRIPT_ID,
    matches: [...TIMEZONE_MATCHES],
    js: [zone.file, TIMEZONE_SPOOF_FILE],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  };
}

/** Make Chrome match `settings` exactly; calling it again with the same settings is harmless. */
export async function applyTimezone(settings, api = globalThis.chrome) {
  const registered = await api.scripting.getRegisteredContentScripts({ ids: [TIMEZONE_SCRIPT_ID] });
  if (registered.length > 0) await api.scripting.unregisterContentScripts({ ids: [TIMEZONE_SCRIPT_ID] });
  if (settings.enabled) {
    await api.scripting.registerContentScripts([buildContentScript(BY_ID.get(settings.timezoneId))]);
  }
}

export function describeTimezone(settings) {
  return {
    settings,
    zones: TIMEZONES.map(({ id, label, timeZone }) => ({ id, label, timeZone })),
  };
}

let queue = Promise.resolve();

/** Run one change at a time so Chrome's registrations never interleave. */
function serialize(task) {
  const run = queue.then(task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function load(api) {
  const stored = await api.storage.local.get([TIMEZONE_SETTINGS_KEY]);
  return normalizeTimezone(stored[TIMEZONE_SETTINGS_KEY]);
}

/** Re-apply the stored setting (install, update, browser start). */
export function syncTimezone(api = globalThis.chrome) {
  return serialize(async () => {
    const settings = await load(api);
    await applyTimezone(settings, api);
    return describeTimezone(settings);
  });
}

export function getTimezone(api = globalThis.chrome) {
  return load(api).then(describeTimezone);
}

/** Change the setting; a failed apply is rolled back so storage matches what Chrome runs. */
export function updateTimezone(patch, api = globalThis.chrome) {
  return serialize(async () => {
    const previous = await load(api);
    const next = normalizeTimezone({ ...previous, ...(patch && typeof patch === "object" ? patch : {}) });
    try {
      await applyTimezone(next, api);
    } catch (error) {
      await applyTimezone(previous, api).catch(() => {});
      throw error;
    }
    await api.storage.local.set({ [TIMEZONE_SETTINGS_KEY]: next });
    return describeTimezone(next);
  });
}

/** Handle a popup message of type timezone.get or timezone.set. */
export function handleTimezoneMessage(message, api = globalThis.chrome) {
  switch (message?.type) {
    case "timezone.get":
      return getTimezone(api);
    case "timezone.set":
      return updateTimezone(message.settings, api);
    default: {
      const error = new Error(`Unsupported timezone message: ${message?.type}`);
      error.code = "method_not_found";
      return Promise.reject(error);
    }
  }
}
