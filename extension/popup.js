const TOKEN_PREFIX_LENGTH = 8;
const TOKEN_SUFFIX_LENGTH = 6;

export function maskToken(token) {
  if (typeof token !== "string" || token.length < TOKEN_PREFIX_LENGTH + TOKEN_SUFFIX_LENGTH) {
    return "Unavailable";
  }
  return `${token.slice(0, TOKEN_PREFIX_LENGTH)}••••••••••••••••${token.slice(-TOKEN_SUFFIX_LENGTH)}`;
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}

function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (response?.ok !== true) {
        reject(new Error(response?.error?.message || "Local bridge is unavailable"));
        return;
      }
      resolve(response.result);
    });
  });
}

function startFeatures(doc) {
  const checker = doc.querySelector("#checker-enabled");
  const region = doc.querySelector("#region-enabled");
  const profile = doc.querySelector("#region-profile");
  const reload = doc.querySelector("#reload-tabs");
  const notice = doc.querySelector("#features-notice");
  const errorElements = {
    chatgptChecker: doc.querySelector("#checker-error"),
    regionLock: doc.querySelector("#region-error"),
  };
  const controls = [checker, region, profile, reload];

  function setBusy(busy) {
    for (const control of controls) control.disabled = busy;
  }

  function render(state) {
    checker.checked = state.settings.chatgptChecker.enabled;
    region.checked = state.settings.regionLock.enabled;
    if (profile.options.length === 0) {
      for (const { id, label, timeZone } of state.profiles) {
        const option = doc.createElement("option");
        option.value = id;
        option.textContent = `${label} (${timeZone})`;
        profile.append(option);
      }
    }
    profile.value = state.settings.regionLock.profileId;
    for (const [name, element] of Object.entries(errorElements)) {
      const message = state.errors?.[name];
      element.hidden = !message;
      element.textContent = message ? `Could not apply: ${message}` : "";
    }
  }

  async function save(patch) {
    setBusy(true);
    try {
      const state = await send("features.set", { settings: patch });
      render(state);
      const failed = Object.keys(state.errors ?? {}).length > 0;
      notice.textContent = failed
        ? "A change could not be applied and was reverted."
        : "Saved. Reload open ChatGPT tabs to apply it.";
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : "Could not save the setting";
      void send("features.get").then(render, () => {});
    } finally {
      setBusy(false);
    }
  }

  checker.addEventListener("change", () => void save({ chatgptChecker: { enabled: checker.checked } }));
  region.addEventListener("change", () => void save({ regionLock: { enabled: region.checked } }));
  profile.addEventListener("change", () => void save({ regionLock: { profileId: profile.value } }));
  reload.addEventListener("click", async () => {
    setBusy(true);
    try {
      const { reloaded, cleaned } = await send("features.reload-tabs");
      notice.textContent = reloaded + cleaned === 0
        ? "No ChatGPT or OpenAI tabs are open."
        : `Reloaded ${reloaded + cleaned} tab${reloaded + cleaned === 1 ? "" : "s"}.`;
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : "Could not reload the tabs";
    } finally {
      setBusy(false);
    }
  });

  void send("features.get").then(
    (state) => {
      render(state);
      setBusy(false);
    },
    () => {
      notice.textContent = "ChatGPT tool settings are unavailable.";
    },
  );
}

export function startPopup(doc = document, clipboard = navigator.clipboard) {
  const connection = doc.querySelector("#connection");
  const tokenElement = doc.querySelector("#token");
  const rotated = doc.querySelector("#rotated");
  const notice = doc.querySelector("#notice");
  const toggle = doc.querySelector("#toggle");
  const copy = doc.querySelector("#copy");
  const renew = doc.querySelector("#renew");

  const instanceId = doc.querySelector("#instance-id");
  const label = doc.querySelector("#label");
  const saveLabel = doc.querySelector("#save-label");

  let token = null;
  let revealed = false;
  let renewArmed = false;
  let renewTimer = null;

  function renderToken() {
    tokenElement.textContent = token ? (revealed ? token : maskToken(token)) : "Unavailable";
    toggle.textContent = revealed ? "Hide" : "Show";
  }

  function setConnected(result) {
    token = result.token;
    revealed = false;
    connection.textContent = "Connected to local bridge";
    connection.className = "status connected";
    rotated.textContent = `Last renewed: ${formatTimestamp(result.rotatedAt)}`;
    toggle.disabled = false;
    copy.disabled = false;
    renew.disabled = false;
    renderToken();
  }

  function setError(error) {
    token = null;
    connection.textContent = "Local bridge unavailable";
    connection.className = "status error";
    notice.textContent = error instanceof Error ? error.message : String(error);
    toggle.disabled = true;
    copy.disabled = true;
    renew.disabled = true;
    renderToken();
  }

  toggle.addEventListener("click", () => {
    revealed = !revealed;
    renderToken();
  });

  copy.addEventListener("click", async () => {
    if (!token) return;
    try {
      await clipboard.writeText(token);
      notice.textContent = "Token copied. Do not paste it into untrusted pages or chats.";
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : "Could not copy token";
    }
  });

  renew.addEventListener("click", async () => {
    if (!renewArmed) {
      renewArmed = true;
      renew.textContent = "Confirm renew";
      renew.classList.add("confirm");
      notice.textContent = "Renewing immediately invalidates the previous token.";
      renewTimer = setTimeout(() => {
        renewArmed = false;
        renew.textContent = "Renew";
        renew.classList.remove("confirm");
      }, 10_000);
      return;
    }

    clearTimeout(renewTimer);
    renewArmed = false;
    renew.disabled = true;
    renew.textContent = "Renewing…";
    try {
      setConnected(await send("auth.renew"));
      notice.textContent = "Token renewed. The previous token is no longer valid.";
    } catch (error) {
      setError(error);
    } finally {
      renew.textContent = "Renew";
      renew.classList.remove("confirm");
    }
  });

  function setInstance(result) {
    instanceId.textContent = result.instanceId;
    label.value = result.label;
    label.disabled = false;
    saveLabel.disabled = false;
  }

  saveLabel.addEventListener("click", async () => {
    saveLabel.disabled = true;
    try {
      setInstance(await send("instance.rename", { label: label.value }));
      notice.textContent = "Browser name saved.";
    } catch (error) {
      notice.textContent = error instanceof Error ? error.message : "Could not save the browser name";
    } finally {
      saveLabel.disabled = false;
    }
  });

  startFeatures(doc);
  void send("instance.get").then(setInstance, () => {});
  void send("auth.get").then(setConnected, setError);
}

if (typeof document !== "undefined") startPopup();
