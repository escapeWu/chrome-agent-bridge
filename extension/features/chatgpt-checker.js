// Optional ChatGPT Checker Next integration (off by default).
//
// When enabled, the unmodified upstream userscript (vendor/, AGPL-3.0) is mounted
// on chatgpt.com as a main-world content script behind a small Tampermonkey shim.
// It fills its own panel from the page's own /backend-api responses and makes no
// requests of its own. `chatgpt_checker_status` reads that panel back as data.

export const CHECKER_SCRIPT_ID = "chrome-agent-bridge-chatgpt-checker";
export const CHECKER_MATCHES = Object.freeze(["https://chatgpt.com/*"]);
export const CHECKER_SHIM_FILE = "features/page/gm-shim.js";
export const CHECKER_USERSCRIPT_FILE = "vendor/chatgpt-checker-next.user.js";
export const CHECKER_LICENSE_FILE = "vendor/CHATGPT-CHECKER-NEXT-LICENSE.txt";
/** Every extension file the checker needs; the release ZIP must contain all of them. */
export const CHECKER_FILES = Object.freeze([CHECKER_SHIM_FILE, CHECKER_USERSCRIPT_FILE, CHECKER_LICENSE_FILE]);

const PANEL_TEXT_LIMIT = 4_000;
const MODEL_OPTION_LIMIT = 60;
const CUSTOM_OPTION_VALUE = "__checker_next_custom__";

export function normalizeChatgptChecker(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return { enabled: candidate.enabled === true };
}

export function buildContentScript() {
  return {
    id: CHECKER_SCRIPT_ID,
    matches: [...CHECKER_MATCHES],
    js: [CHECKER_SHIM_FILE, CHECKER_USERSCRIPT_FILE],
    allFrames: false, // the userscript declares @noframes
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  };
}

/** Make Chrome match `settings` exactly; calling it again with the same settings is harmless. */
export async function applyChatgptChecker(settings, api = globalThis.chrome) {
  const registered = await api.scripting.getRegisteredContentScripts({ ids: [CHECKER_SCRIPT_ID] });
  if (registered.length > 0) {
    await api.scripting.unregisterContentScripts({ ids: [CHECKER_SCRIPT_ID] });
  }
  if (settings.enabled) {
    await api.scripting.registerContentScripts([buildContentScript()]);
  }
}

/** True for tab URLs the checker mounts on. */
export function isCheckerUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "chatgpt.com";
  } catch {
    return false;
  }
}

/**
 * Runs inside the ChatGPT tab (serialized by chrome.scripting.executeScript, so it
 * must stay self-contained). It only flattens the checker's panel into plain data;
 * interpretPanel() gives that data its meaning.
 */
export function collectCheckerPanel() {
  const box = document.getElementById("checker-next-displayBox");
  if (!box) return null;
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
  const elements = {};
  for (const element of box.querySelectorAll("[id]")) {
    const entry = {
      text: clean(element.textContent),
      hidden: getComputedStyle(element).display === "none",
    };
    if (element instanceof HTMLInputElement && element.type === "checkbox") entry.checked = element.checked;
    if (element instanceof HTMLSelectElement) {
      entry.value = element.value;
      entry.options = [...element.options].map((option) => ({
        value: option.value,
        label: clean(option.textContent),
        unavailable: option.disabled || option.hidden,
      }));
    }
    elements[element.id] = entry;
  }
  const windows = [...box.querySelectorAll("#codex-windows-container > div")].map((row) => ({
    label: clean(row.querySelector(".codex-window-label")?.textContent),
    used: clean(row.querySelector(".codex-window-usage")?.textContent),
    resetTime: clean(row.querySelector(".codex-window-reset-time")?.textContent),
  }));
  const version = [...box.querySelectorAll("a")]
    .map((link) => /^v(\d+\.\d+\.\d+)$/.exec(clean(link.textContent))?.[1])
    .find(Boolean);
  return {
    mode: box.dataset.mode || null,
    version: version || null,
    text: clean(box.innerText).slice(0, 4_000),
    elements,
    windows,
  };
}

const FEATURE_LIMITS = Object.freeze([
  ["deep-research", "Deep research"],
  ["image-gen", "Image generation"],
  ["file-upload", "File upload"],
  ["paste-text-to-file", "Paste text as file"],
]);

// The panel's own difficulty verdicts, from the checker's updateDifficultyIndicator().
const POW_ASSESSMENTS = Object.freeze({ "风险": "risk", "中等": "medium", "良好": "good", "优秀": "excellent" });

/** Turn the flat panel data from collectCheckerPanel() into the documented status object. */
export function interpretPanel(raw) {
  const entries = raw.elements ?? {};
  const known = (id) => {
    const text = entries[id]?.text;
    return text && text !== "..." && text !== "…" ? text : null;
  };
  const shown = (id) => entries[id] != null && entries[id].hidden !== true;
  const choice = (id) => {
    const select = entries[id];
    if (!select?.options) return null;
    const selected = select.options.find((option) => option.value === select.value);
    const options = select.options
      .filter((option) => option.value !== "" && option.value !== CUSTOM_OPTION_VALUE && !option.unavailable)
      .slice(0, MODEL_OPTION_LIMIT)
      .map(({ value, label }) => ({ value, label }));
    return {
      value: select.value && select.value !== CUSTOM_OPTION_VALUE ? select.value : null,
      label: selected && selected.value !== "" && selected.value !== CUSTOM_OPTION_VALUE ? selected.label : null,
      options,
    };
  };

  const level = known("difficulty-level")?.replace(/[()（）]/g, "") ?? null;
  const memory = /^(\d+)\/(\d+)$/.exec(known("memory-usage") ?? "");
  const toggles = {};
  for (const [id, entry] of Object.entries(entries)) {
    if (id.endsWith("-toggle") && typeof entry.checked === "boolean") toggles[id.slice(0, -"-toggle".length)] = entry.checked;
  }

  return {
    present: true,
    mode: raw.mode,
    version: raw.version,
    pow: {
      difficulty: known("difficulty"),
      level,
      assessment: level ? POW_ASSESSMENTS[level] ?? null : null,
    },
    persona: known("persona"),
    userRegion: known("user-region"),
    localeInfo: known("locale-info"),
    model: {
      mode: choice("chatgpt-runtime-origin"),
      model: choice("chatgpt-runtime-model"),
      thinking: choice("chatgpt-runtime-thinking"),
      error: shown("chatgpt-runtime-error") ? known("chatgpt-runtime-error") : null,
    },
    limits: FEATURE_LIMITS.map(([id, label]) => ({
      id,
      label,
      visible: shown(`${id}-section`),
      remaining: known(`${id}-usage`),
      resetTime: known(`${id}-reset-time`),
    })),
    memory: shown("memory-section") && memory ? { used: Number(memory[1]), max: Number(memory[2]) } : null,
    codex: shown("codex-section")
      ? {
          windows: (raw.windows ?? []).map(({ label, used, resetTime }) => ({
            label: label || null,
            used: used && used !== "..." ? used : null,
            resetTime: resetTime && resetTime !== "..." ? resetTime : null,
          })),
          credits: shown("codex-credits-container") ? known("codex-credits-value") : null,
          resetCredits: shown("codex-reset-credits-container") ? known("codex-reset-credits-count") : null,
        }
      : null,
    moduleInjection: known("chatgpt-injection-status"),
    toggles,
    text: (raw.text ?? "").slice(0, PANEL_TEXT_LIMIT),
  };
}
