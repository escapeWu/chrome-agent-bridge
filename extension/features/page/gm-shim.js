// Userscript-manager globals for the vendored ChatGPT Checker Next script.
//
// The checker was written for Tampermonkey (`@sandbox raw`, `@grant unsafeWindow`,
// `@grant GM_addElement`) and references those names as free variables. This
// shim runs first, in the page's main world, so the unmodified script can run
// as a registered content script. Keep GM_INFO_VERSION in step with the
// `@version` header of vendor/chatgpt-checker-next.user.js (a test enforces it).
(() => {
  "use strict";

  const GM_INFO_VERSION = "5.2.2";

  function hide(name, value) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      writable: false,
      value,
    });
  }

  function addElement(parentOrTag, tagOrAttributes, maybeAttributes) {
    const hasParent = typeof parentOrTag !== "string";
    const tag = hasParent ? tagOrAttributes : parentOrTag;
    const attributes = (hasParent ? maybeAttributes : tagOrAttributes) || {};
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "textContent" || name === "innerText") element.textContent = value;
      else element.setAttribute(name, value);
    }

    // At document_start there may be no <head> yet; attach as soon as one exists.
    const attach = () => {
      const parent = hasParent ? parentOrTag : document.head || document.documentElement;
      if (!parent) return false;
      parent.appendChild(element);
      return true;
    };
    if (!attach()) {
      const observer = new MutationObserver(() => {
        if (attach()) observer.disconnect();
      });
      observer.observe(document, { childList: true, subtree: true });
    }
    return element;
  }

  hide("unsafeWindow", globalThis);
  hide("GM_addElement", addElement);
  hide("GM_info", Object.freeze({
    scriptHandler: "Chrome Agent Bridge",
    script: Object.freeze({ name: "ChatGPT Checker Next", version: GM_INFO_VERSION }),
  }));
})();
