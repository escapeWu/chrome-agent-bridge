# ChatGPT Checker

Read this reference only to inspect the account, model, and usage status that the optional ChatGPT Checker panel shows on a signed-in `https://chatgpt.com` tab.

## Prerequisite

The user must have turned on **ChatGPT Checker** in the extension popup (**ChatGPT tools**) and reloaded the ChatGPT tab. It is off by default and an agent cannot enable it. On `checker_disabled`, ask the user to turn it on; do not read the same data some other way (snapshots, page scripts, or Raw CDP).

## Tool

- `chatgpt_checker_status({tabId, browser?})`: Read the checker panel of one chatgpt.com tab as data. Read-only; it never sends a message and returns no chat content, URL, or title.

Call shape:

```text
browser_list_tabs()                       → pick a tab whose URL is https://chatgpt.com/…
chatgpt_checker_status({tabId})
```

## Reading the result

- `panel.pow`: `difficulty`, the checker's own verdict `level` (风险, 中等, 良好, 优秀), and `assessment` (`risk`, `medium`, `good`, `excellent`). Report the verdict as the checker's; do not turn it into a claim about the account.
- `panel.persona`, `panel.userRegion` (country / region / currency), `panel.localeInfo` (time zone / language).
- `panel.model`: selected `mode`, `model`, and `thinking`, each with its `options`.
- `panel.limits`: remaining uses and reset time for deep research, image generation, file upload, and pasted-text uploads; `visible:false` means ChatGPT did not report that limit.
- `panel.memory` and `panel.codex` (usage windows, credits, reset chances), or `null` when not reported.
- `panel.toggles`: the checker's own on/off switches. `panel.moduleInjection`: whether its model-injection feature loaded.
- `regionLock`: whether the user's optional US region lock is on, and its profile.

A field is `null` until the page has made the matching request. The difficulty appears only after the first message is sent in that tab. Do not send a message just to fill it in unless the user asks; ask first.

## Errors

- `checker_disabled`: the user has not enabled it. Ask them to.
- `not_chatgpt_tab` / `tab_not_found`: re-list tabs and pass a current chatgpt.com `tabId`.
- `panel.present:false`: the panel is not on the page. Tabs loaded before the feature was enabled need a reload (the user can use **Reload ChatGPT tabs** in the popup), then retry once the tab finishes loading.
- `checker_unreadable`: Chrome refused to read the tab (for example an error page). Reload it and retry.

Never change the user's region lock or checker settings; they are popup-only.
