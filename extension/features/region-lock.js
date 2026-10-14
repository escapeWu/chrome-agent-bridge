// Optional US region lock for openai.com and chatgpt.com (off by default).
//
// Enabling it sets the request `Accept-Language` through declarativeNetRequest
// and registers a main-world content script that aligns navigator language,
// <html lang>, Intl and Date with the chosen US time zone. It never reads page
// content or account data, and it cannot change the public IP address.

export const REGION_LOCK_SCRIPT_ID = "chrome-agent-bridge-region-lock";
export const REGION_LOCK_RULE_ID = 61001;
export const REGION_LOCK_DOMAINS = Object.freeze(["openai.com", "chatgpt.com"]);
export const REGION_LOCK_MATCHES = Object.freeze([
  "https://openai.com/*",
  "https://*.openai.com/*",
  "https://chatgpt.com/*",
  "https://*.chatgpt.com/*",
]);
export const REGION_SPOOF_FILE = "features/page/region-spoof.js";
export const DEFAULT_REGION_PROFILE_ID = "us-east";

// Without `resourceTypes` a rule skips main_frame, which is the request that
// decides the server-side locale, so every type is named explicitly.
const HEADER_RESOURCE_TYPES = Object.freeze([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "media", "websocket", "other",
]);

function usProfile(id, label, timeZone) {
  return Object.freeze({
    id,
    label,
    timeZone,
    locale: "en-US",
    languageLabel: "English (United States)",
    acceptLanguage: "en-US,en;q=0.9",
    file: `features/page/profiles/${id}.js`,
  });
}

export const REGION_PROFILES = Object.freeze({
  "us-east": usProfile("us-east", "US Eastern", "America/New_York"),
  "us-central": usProfile("us-central", "US Central", "America/Chicago"),
  "us-mountain": usProfile("us-mountain", "US Mountain", "America/Denver"),
  "us-pacific": usProfile("us-pacific", "US Pacific", "America/Los_Angeles"),
});

/** Every extension file the region lock needs; the release ZIP must contain all of them. */
export const REGION_LOCK_FILES = Object.freeze([
  REGION_SPOOF_FILE,
  ...Object.values(REGION_PROFILES).map((profile) => profile.file),
]);

export function normalizeRegionLock(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    enabled: candidate.enabled === true,
    profileId: Object.hasOwn(REGION_PROFILES, candidate.profileId)
      ? candidate.profileId
      : DEFAULT_REGION_PROFILE_ID,
  };
}

export function describeRegionLock(settings) {
  const profile = REGION_PROFILES[settings.profileId];
  return {
    enabled: settings.enabled,
    profileId: profile.id,
    label: profile.label,
    timeZone: profile.timeZone,
    locale: profile.locale,
    acceptLanguage: profile.acceptLanguage,
  };
}

export function buildHeaderRule(profile) {
  return {
    id: REGION_LOCK_RULE_ID,
    priority: 100,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "accept-language", operation: "set", value: profile.acceptLanguage }],
    },
    condition: {
      requestDomains: [...REGION_LOCK_DOMAINS],
      resourceTypes: [...HEADER_RESOURCE_TYPES],
    },
  };
}

export function buildContentScript(profile) {
  return {
    id: REGION_LOCK_SCRIPT_ID,
    matches: [...REGION_LOCK_MATCHES],
    js: [profile.file, REGION_SPOOF_FILE],
    allFrames: true,
    matchOriginAsFallback: true,
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  };
}

/** Make Chrome match `settings` exactly; calling it again with the same settings is harmless. */
export async function applyRegionLock(settings, api = globalThis.chrome) {
  const profile = REGION_PROFILES[settings.profileId];
  await api.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [REGION_LOCK_RULE_ID],
    addRules: settings.enabled ? [buildHeaderRule(profile)] : [],
  });

  const registered = await api.scripting.getRegisteredContentScripts({ ids: [REGION_LOCK_SCRIPT_ID] });
  if (registered.length > 0) {
    await api.scripting.unregisterContentScripts({ ids: [REGION_LOCK_SCRIPT_ID] });
  }
  if (settings.enabled) {
    await api.scripting.registerContentScripts([buildContentScript(profile)]);
  }
}

/** True for tab URLs the region lock covers (openai.com, chatgpt.com, and their subdomains). */
export function isRegionLockUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" &&
    REGION_LOCK_DOMAINS.some((domain) => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
}

/** The apex openai.com page with the `/zh-Hans-CN` locale prefix removed, or null if it has none. */
export function cleanOpenAiRegionPath(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "openai.com") return null;
  const cleaned = url.pathname.replace(/^\/zh-Hans-CN(?=\/|$)/, "");
  if (cleaned === url.pathname) return null;
  url.pathname = cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  return url.href;
}
