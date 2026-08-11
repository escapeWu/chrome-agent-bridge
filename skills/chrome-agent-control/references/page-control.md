# Page control

Read this reference for tab management, visible page inspection, screenshots, navigation, clicks, fills, and tab lifecycle events.

## Tools

- `browser_list_tabs`: List current HTTP, HTTPS, file, and `about:blank` tabs.
- `browser_open_tab`: Open a safe URL in a new tab.
- `browser_activate_tab`: Activate a tab and focus its window.
- `browser_close_tab`: Close only a tab created by the bridge in the current extension session.
- `browser_navigate`: Navigate an existing tab to a safe URL.
- `browser_snapshot`: Return visible text and interactive elements with CSS selectors.
- `browser_screenshot`: Capture the visible viewport.
- `browser_click`: Click one visible, enabled element. Consequential submitters require `confirmed=true` after explicit confirmation.
- `browser_fill`: Fill one visible non-password field.
- `browser_watch_events`: Poll tab lifecycle and navigation events after a cursor; pass `tabId` to exclude unrelated tabs.

Minimal call shapes:

```text
browser_snapshot({tabId})
browser_click({tabId, selector, confirmed:false})
browser_fill({tabId, selector, value})
browser_watch_events({afterCursor, tabId?, timeoutMs?})
```

## Action loop

1. Take a fresh `browser_snapshot` before acting on an unfamiliar or changed page.
2. Select an element using a selector from that snapshot.
3. Perform one intentional click or fill.
4. Re-read the cheapest authoritative state after the action. Use a screenshot only when layout matters.
5. Leave pre-existing tabs open. Close only task-created tabs when cleanup was requested.

## Boundaries and recovery

- Supported URLs are `http:`, `https:`, `file:`, and `about:blank`. File URLs may require the user to enable file access for the extension. Chrome-internal pages cannot be inspected or scripted.
- `tab_not_found`: refresh the tab list and select again.
- `selector_not_found`: take a fresh snapshot and choose a current selector.
- `restricted_page`: ask the user to open a normal web page.
- `confirmation_required`: stop and obtain confirmation for the exact consequential click; do not reuse confirmation for another action.
- Password fields are rejected by `browser_fill`. Do not use Raw CDP to bypass that boundary.
