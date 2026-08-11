# Tool contract

## Tools

- `browser_status`: Verify that the extension and native host are connected.
- `browser_list_tabs`: List current HTTP, HTTPS, file, and `about:blank` tabs.
- `browser_open_tab`: Open a safe URL in a new tab.
- `browser_activate_tab`: Make a tab active and focus its window.
- `browser_close_tab`: Close a tab created by the bridge in the current extension session. Pre-existing tabs are rejected.
- `browser_navigate`: Navigate an existing tab to a safe URL.
- `browser_snapshot`: Return visible text and interactive elements with CSS selectors.
- `browser_screenshot`: Capture the visible viewport of a tab.
- `browser_click`: Click one visible, enabled element selected from a fresh snapshot. Form submitters require `confirmed=true` after explicit user confirmation.
- `browser_fill`: Fill one visible text field. Password fields are always rejected.
- `browser_watch_events`: Long-poll tab lifecycle and navigation events after a sequence cursor. Pass `tabId` when monitoring one tab in a busy browser.
- `browser_network_start`: Create a bounded metadata-only monitoring session. Without `rawSessionId`, it owns a new tab attachment. With a matching active `rawSessionId`, it reuses that Raw attachment. `urlMode="origin_path"` removes queries; `urlMode="full"` preserves queries but still removes credentials and fragments.
- `browser_network_poll`: Long-poll sanitized request, response, completion, failure, and WebSocket lifecycle metadata after a session cursor. Completion and failure events include method, status when known, and CDP-monotonic `durationMs`.
- `browser_network_stop`: Stop the session and release its resources. It detaches only when it owns the debugger attachment; a reused Raw session remains attached. Always call it when monitoring is finished.
- `browser_cdp_attach`: Attach an unrestricted Raw CDP session to one tab. Set `captureEvents=false` when only commands plus a safe network projection are needed.
- `browser_cdp_send`: Forward any CDP method and JSON params without an allowlist or response sanitization. `targetSessionId` addresses a child target registered in the same Raw session.
- `browser_cdp_events`: Long-poll original CDP event source, method, and params after a cursor without field sanitization.
- `browser_cdp_detach`: Detach Raw CDP and clear active child-target routing. Always call it after Raw work.

Network results always omit URL credentials, fragments, headers, bodies, security details, and raw CDP request IDs. Queries are omitted by default; `urlMode="full"` is an explicit sensitive opt-in. A Chrome tab can have only one external debugger owner, but a projected network session can share the bridge's Raw attachment by passing `rawSessionId`.

Raw CDP deliberately does the opposite: it preserves original command results and event params and may expose cookies, credentials, storage, page content, bodies, and WebSocket frames. Buffers and result envelopes are size-bounded, but CDP methods and fields are not allowlisted.

## URL policy

The extension accepts `http:`, `https:`, `file:`, and `about:blank`. Chrome may require the user to enable file URL access for the extension. Browser-internal pages such as `chrome://` cannot be inspected or scripted.

## Recovery

- For `bridge_offline`, verify the unpacked release is loaded, install the native host with `npm run install-host`, ask the user to reload the extension, then retry `browser_status`.
- For `unauthorized`, do not request the token in chat. Local installations should reread `~/.chrome-agent-bridge/auth.json` automatically; separately configured agents must receive the popup token through `CHROME_AGENT_BRIDGE_TOKEN`. Renew in the popup if the old token may be stale or exposed.
- For `tab_not_found`, refresh the tab list and select again.
- For `selector_not_found`, take a fresh snapshot and choose a current selector.
- For `restricted_page`, ask the user to open a normal web page.
- For `confirmation_required`, stop before the consequential action and ask the user.
