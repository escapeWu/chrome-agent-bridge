# Connection and recovery

Read this reference only when installing the bridge or when status/authentication fails.

## Connect

1. Call `browser_status` and require `connected: true` before browser work.
2. For `bridge_offline`, verify that the released Extension ZIP is extracted and loaded, run `npm run install-host` from the bridge repository when authorized, ask the user to reload the extension, then retry.
3. Do not ask for an extension ID for the official release. The stable ID is already configured by the installer.
4. Local agents automatically read the long-lived token from `~/.chrome-agent-bridge/auth.json`.
5. Only a deliberately separate local process should receive the popup token through `CHROME_AGENT_BRIDGE_TOKEN`. Keep it out of chat, logs, commands, and project files.

## Several browsers

Each Chrome profile (or `--user-data-dir`) registers as its own browser with an `instanceId` and a user-editable label (extension popup).

- `browser_list_instances` shows each browser, whether it is reachable, and its tab count.
- `browser_ambiguous`: more than one browser is connected and no `browser` was given. Retry with an `instanceId` or label; do not pick one silently.
- `browser_not_found`: the selector matches nothing. Re-list; the browser may have closed or its host restarted.
- `browser_mismatch`: a `sessionId` and `browser` point at different browsers. Drop `browser`; the session already identifies its browser.
- `browser_cdp_attach` and `browser_network_start` return session IDs prefixed with the instance (`<instanceId>~raw_…`). Pass them back unchanged.
- `browser_watch_events` cursors are per browser; keep one cursor for each.
- `browser_debugger_sessions` lists which sessions hold tab debugger attachments in one browser, with lease expiry and owner labels. Busy errors and the list return prefixed IDs; a session in one browser never blocks a tab in another.

## Recover

- `unauthorized`: reread the local auth file automatically. If the credential may be stale or exposed, ask the user to select **Renew** and **Confirm renew** in the extension popup; the old token becomes invalid immediately.
- `bridge_offline` after host installation: reload the extension and restart or reload the MCP client.
- Missing Chrome approval: ask the user to open `chrome://extensions`, enable **Developer mode**, and load the extracted release directory. Do not attempt to bypass this visible step.

For a full installation or upgrade, follow the repository's `docs/agent-installation.md` and install the paired `chrome-agent-control` Skill as well as the Extension and MCP server.
