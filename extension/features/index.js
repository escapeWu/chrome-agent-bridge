// Optional ChatGPT features, both off by default and switched only from the popup:
//   chatgptChecker  the ChatGPT Checker Next panel, readable through chatgpt_checker_status
//   regionLock      a US language and time-zone profile for openai.com and chatgpt.com
// Settings live in chrome.storage.local (never synced). The content scripts and
// network rules they register are re-applied on install, update and browser start,
// and whenever a setting changes, so Chrome always matches the stored settings.

import {
  applyChatgptChecker,
  CHECKER_MATCHES,
  collectCheckerPanel,
  interpretPanel,
  isCheckerUrl,
  normalizeChatgptChecker,
} from "./chatgpt-checker.js";
import {
  applyRegionLock,
  cleanOpenAiRegionPath,
  describeRegionLock,
  isRegionLockUrl,
  normalizeRegionLock,
  REGION_LOCK_MATCHES,
  REGION_PROFILES,
} from "./region-lock.js";

export const FEATURE_SETTINGS_KEY = "featureSettings";
export const FEATURE_ERRORS_KEY = "featureErrors";

const APPLIERS = Object.freeze({
  chatgptChecker: applyChatgptChecker,
  regionLock: applyRegionLock,
});

function featureError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeFeatureSettings(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    chatgptChecker: normalizeChatgptChecker(candidate.chatgptChecker),
    regionLock: normalizeRegionLock(candidate.regionLock),
  };
}

let queue = Promise.resolve();

/** Run one settings change at a time so Chrome's registrations never interleave. */
function serialize(task) {
  const run = queue.then(task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function loadSettings(api) {
  const stored = await api.storage.local.get([FEATURE_SETTINGS_KEY]);
  return normalizeFeatureSettings(stored[FEATURE_SETTINGS_KEY]);
}

async function loadErrors(api) {
  const stored = await api.storage.local.get([FEATURE_ERRORS_KEY]);
  const errors = stored[FEATURE_ERRORS_KEY];
  return errors && typeof errors === "object" ? errors : {};
}

/** Apply the named features independently; one failing never blocks the other. */
async function applyFeatures(settings, names, api) {
  const errors = {};
  await Promise.all(names.map(async (name) => {
    try {
      await APPLIERS[name](settings[name], api);
    } catch (error) {
      errors[name] = error instanceof Error ? error.message : String(error);
    }
  }));
  return errors;
}

function describeState(settings, errors) {
  return {
    settings,
    errors,
    regionLock: describeRegionLock(settings.regionLock),
    profiles: Object.values(REGION_PROFILES).map(({ id, label, timeZone }) => ({ id, label, timeZone })),
  };
}

/** Re-apply the stored settings (install, update, browser start). */
export function syncFeatures(api = globalThis.chrome) {
  return serialize(async () => {
    const settings = await loadSettings(api);
    const errors = await applyFeatures(settings, Object.keys(APPLIERS), api);
    await api.storage.local.set({ [FEATURE_ERRORS_KEY]: errors });
    return describeState(settings, errors);
  });
}

export async function getFeatureState(api = globalThis.chrome) {
  return describeState(await loadSettings(api), await loadErrors(api));
}

/**
 * Change settings. `patch` may hold `chatgptChecker` and/or `regionLock`. A feature
 * that fails to apply is rolled back to its previous settings and reported in
 * `errors`, so the stored settings always match what Chrome is running.
 */
export function updateFeatures(patch, api = globalThis.chrome) {
  return serialize(async () => {
    const previous = await loadSettings(api);
    const requested = patch && typeof patch === "object" ? patch : {};
    const next = normalizeFeatureSettings({
      chatgptChecker: { ...previous.chatgptChecker, ...requested.chatgptChecker },
      regionLock: { ...previous.regionLock, ...requested.regionLock },
    });
    const changed = Object.keys(APPLIERS)
      .filter((name) => JSON.stringify(previous[name]) !== JSON.stringify(next[name]));
    const errors = await applyFeatures(next, changed, api);

    const settings = { ...next };
    for (const name of Object.keys(errors)) {
      settings[name] = previous[name];
      await APPLIERS[name](previous[name], api).catch(() => {});
    }
    await api.storage.local.set({ [FEATURE_SETTINGS_KEY]: settings, [FEATURE_ERRORS_KEY]: errors });
    return describeState(settings, errors);
  });
}

/**
 * Reload open openai.com and chatgpt.com tabs so a changed setting takes effect.
 * With the region lock on, an apex openai.com tab sitting on a /zh-Hans-CN path is
 * navigated to the cleaned path instead of reloaded.
 */
export async function reloadChatgptTabs(api = globalThis.chrome) {
  const { regionLock } = await loadSettings(api);
  const tabs = await api.tabs.query({ url: [...new Set([...CHECKER_MATCHES, ...REGION_LOCK_MATCHES])] });
  let reloaded = 0;
  let cleaned = 0;
  for (const tab of tabs) {
    if (!Number.isInteger(tab.id) || !isRegionLockUrl(tab.url)) continue;
    const target = regionLock.enabled ? cleanOpenAiRegionPath(tab.url) : null;
    if (target) {
      await api.tabs.update(tab.id, { url: target });
      cleaned += 1;
    } else {
      await api.tabs.reload(tab.id);
      reloaded += 1;
    }
  }
  return { reloaded, cleaned };
}

/** Handle a popup message of type features.get, features.set or features.reload-tabs. */
export function handleFeatureMessage(message, api = globalThis.chrome) {
  switch (message?.type) {
    case "features.get":
      return getFeatureState(api);
    case "features.set":
      return updateFeatures(message.settings, api);
    case "features.reload-tabs":
      return reloadChatgptTabs(api);
    default:
      return Promise.reject(featureError("method_not_found", `Unsupported feature message: ${message?.type}`));
  }
}

/** Bridge method `checker.status`: the ChatGPT Checker panel of one chatgpt.com tab, as data. */
export async function chatgptCheckerStatus(params = {}, api = globalThis.chrome) {
  const settings = await loadSettings(api);
  if (!settings.chatgptChecker.enabled) {
    throw featureError(
      "checker_disabled",
      "ChatGPT Checker is off. Ask the user to turn it on in the Chrome Agent Bridge popup (ChatGPT tools), then reload the ChatGPT tab.",
    );
  }

  const { tabId } = params;
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw featureError("invalid_tab_id", "tabId must be a non-negative integer");
  }
  let tab;
  try {
    tab = await api.tabs.get(tabId);
  } catch {
    throw featureError("tab_not_found", `Chrome tab ${tabId} was not found`);
  }
  if (!isCheckerUrl(tab.url)) {
    throw featureError("not_chatgpt_tab", `Tab ${tabId} is not a chatgpt.com page; pick one with browser_list_tabs`);
  }

  let raw;
  try {
    [{ result: raw }] = await api.scripting.executeScript({ target: { tabId }, func: collectCheckerPanel });
  } catch (error) {
    throw featureError("checker_unreadable", error instanceof Error ? error.message : String(error));
  }

  // Only the tab's identity and load state are returned: its URL and title name the
  // conversation, and chat content is never read.
  return {
    tab: { id: tab.id, windowId: tab.windowId, active: Boolean(tab.active), status: tab.status ?? null },
    panel: raw
      ? interpretPanel(raw)
      : {
          present: false,
          hint: "The checker panel is not on this page. It attaches only to pages loaded after the feature was enabled: reload the tab, wait for it to finish loading, then retry.",
        },
    regionLock: describeRegionLock(settings.regionLock),
  };
}
