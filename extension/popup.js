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

function send(type) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type }, (response) => {
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

export function startPopup(doc = document, clipboard = navigator.clipboard) {
  const connection = doc.querySelector("#connection");
  const tokenElement = doc.querySelector("#token");
  const rotated = doc.querySelector("#rotated");
  const notice = doc.querySelector("#notice");
  const toggle = doc.querySelector("#toggle");
  const copy = doc.querySelector("#copy");
  const renew = doc.querySelector("#renew");

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

  void send("auth.get").then(setConnected, setError);
}

if (typeof document !== "undefined") startPopup();
