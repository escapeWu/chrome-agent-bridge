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

## URL policy

The extension accepts `http:`, `https:`, `file:`, and `about:blank`. Chrome may require the user to enable file URL access for the extension. Browser-internal pages such as `chrome://` cannot be inspected or scripted.

## Recovery

- For `bridge_offline`, verify the unpacked release is loaded, install the native host with `npm run install-host`, ask the user to reload the extension, then retry `browser_status`.
- For `unauthorized`, do not request the token in chat. Local installations should reread `~/.chrome-agent-bridge/auth.json` automatically; separately configured agents must receive the popup token through `CHROME_AGENT_BRIDGE_TOKEN`. Renew in the popup if the old token may be stale or exposed.
- For `tab_not_found`, refresh the tab list and select again.
- For `selector_not_found`, take a fresh snapshot and choose a current selector.
- For `restricted_page`, ask the user to open a normal web page.
- For `confirmation_required`, stop before the consequential action and ask the user.
