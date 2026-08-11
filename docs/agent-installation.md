# Install Chrome Agent Bridge for an Agent

This guide is written for an MCP-compatible Agent that needs to install and connect Chrome Agent Bridge on the user's local machine. The Agent may run the terminal steps and prepare the MCP configuration. Chrome requires the user to complete one visible approval step: loading the extracted extension from `chrome://extensions`.

## Trust boundary

- Install only from `https://github.com/escapeWu/chrome-agent-bridge` and its GitHub Releases.
- Never ask the user to paste the pairing token into chat when the Agent runs as the same local OS user. The MCP server reads `~/.chrome-agent-bridge/auth.json` automatically.
- Treat the token as a full browser-control credential. Raw CDP can expose private page data, cookies, storage, request and response bodies, and credentials available to the attached tab.
- Do not expose the loopback RPC port, forward it, or copy the token to another machine.

## What the Agent can install

The Agent can clone the repository, install Node dependencies, register the Native Messaging host, and write its own MCP configuration. The user must load or reload the Chrome extension because Chrome deliberately requires that visible approval.

Requirements:

- Node.js 18 or newer
- Google Chrome
- macOS or Linux
- An MCP client that can start a local stdio server

## Step 1: install the local bridge

Choose a permanent directory. The Native Messaging launcher stores an absolute path to this checkout, so do not move or delete it after installation.

```bash
git clone https://github.com/escapeWu/chrome-agent-bridge.git
cd chrome-agent-bridge
npm ci
npm run install-host
```

The released extension has the stable ID `hkedmoboloodflgcaidimhddljdnndcd`; the installer already allows that ID. Do not ask the user to copy an extension ID when installing an official release.

## Step 2: ask the user to approve the extension

1. Download `chrome-agent-bridge-extension-vX.Y.Z.zip` from [GitHub Releases](https://github.com/escapeWu/chrome-agent-bridge/releases).
2. Extract it into a permanent directory. Chrome cannot install this ZIP directly.
3. Open `chrome://extensions` in Chrome.
4. Enable **Developer mode**.
5. Select **Load unpacked** and choose the extracted extension directory.
6. Pin or open **Chrome Agent Bridge** and verify that its popup reports a connected local bridge.

This is the only required user-visible installation approval. The Agent must not attempt to bypass it.

## Step 3: configure the MCP client

Use the absolute path to the checkout. Do not place the token in this configuration for an Agent running as the same local user.

```json
{
  "mcpServers": {
    "chrome-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-agent-bridge/mcp/server.mjs"]
    }
  }
}
```

Restart or reload the MCP client after adding the server. This repository is also a Codex plugin bundle: `.codex-plugin/plugin.json` registers `.mcp.json` and the `chrome-agent-control` skill for clients that support local Codex plugins.

Only a deliberately separate local process should use the copied token:

```json
{
  "mcpServers": {
    "chrome-agent-bridge": {
      "command": "node",
      "args": ["/absolute/path/to/chrome-agent-bridge/mcp/server.mjs"],
      "env": {
        "CHROME_AGENT_BRIDGE_TOKEN": "TOKEN_COPIED_LOCALLY_BY_THE_USER"
      }
    }
  }
}
```

Do not commit that configuration or print its token in logs. Prefer automatic local discovery whenever possible.

## Step 4: install the paired Skill

The Extension ZIP contains only the Chrome extension. Standalone MCP configuration exposes tools but does not install the workflow instructions that teach an Agent how to scope tabs, start monitoring before an action, avoid incomplete page observers, protect secrets, and clean up debugger sessions.

Install the `chrome-agent-control` Skill from:

```text
https://github.com/escapeWu/chrome-agent-bridge/tree/main/skills/chrome-agent-control
```

For Codex, invoke `$skill-installer` and ask it to install that GitHub Skill path. If the repository is installed as a Codex plugin bundle, `.codex-plugin/plugin.json` already registers both `.mcp.json` and the Skill; do not install a duplicate copy.

For another Agent, copy or register the `skills/chrome-agent-control` directory using that Agent's Skill installation mechanism. Confirm the Skill named `chrome-agent-control` is available before browser work. MCP-only installation is not considered complete or supported Agent setup.

After installing or updating a Skill, start a new Agent task or reload the client so its Skill catalog is refreshed.

## Step 5: verify the connection

The Agent should call:

1. `browser_status` and require `connected: true`.
2. `browser_list_tabs` and ask the user which existing tab is in scope when that is not already explicit.
3. `browser_snapshot` before the first high-level page action.
4. `browser_act` once with a ref from that snapshot, then take a new snapshot to verify. Never reuse a ref after an action or navigation.

Do not guess a tab ID or inspect unrelated tabs.

If `browser_status` reports offline:

1. Confirm `npm run install-host` completed in the current checkout.
2. Reload **Chrome Agent Bridge** from `chrome://extensions`.
3. Reopen its popup and check the connection state.
4. Restart the MCP client if its server was configured while the client was already running.

## Token renewal

The token is long-lived and remains valid until the user renews it. To rotate it, the user opens the extension popup, selects **Renew**, and confirms the second prompt. Renewal replaces `~/.chrome-agent-bridge/auth.json` atomically and invalidates the previous token immediately.

An Agent using automatic local discovery normally needs no configuration change after renewal. A process using `CHROME_AGENT_BRIDGE_TOKEN` must receive the new token locally and restart.

## Network and Raw CDP sessions

For sanitized request lifecycle metadata:

1. Call `browser_network_start` before the user-requested action.
2. Perform the authorized page action with `browser_snapshot → browser_act(ref) → browser_snapshot`. The action engine reuses an active debugger attachment automatically.
3. Page through `browser_network_poll` using its cursor.
4. Always call `browser_network_stop`.

The default `urlMode="origin_path"` removes query strings. Use `urlMode="full"` only when the task requires query parameters and the user-authorized scope permits potentially sensitive URLs. Headers, bodies, URL credentials, fragments, security details, and raw CDP request IDs are never returned by the projected stream. Finished and failed events include `method`, `status` when known, and `durationMs`.

For Raw commands plus a safe network projection on the same tab:

1. Call `browser_cdp_attach` with `captureEvents=false`.
2. Call `browser_network_start` with the same `tabId` and the Raw `sessionId` as `rawSessionId`.
3. Send authorized commands with `browser_cdp_send` and read summaries with `browser_network_poll`.
4. Call `browser_network_stop`.
5. Call `browser_cdp_detach`, including after errors.

Set `captureEvents=true` and call `browser_cdp_events` only when the task explicitly requires original unsanitized events. Do not echo or persist their secrets.

Do not use Resource Timing, `performance.getEntriesByType("resource")`, or page-level fetch/XHR monkeypatching as the normal monitoring path. Those mechanisms are incomplete, depend on page state, may miss workers or frames, and can alter page behavior. Do not change an unrelated UI control merely to manufacture a request after monitoring started too late.

## Upgrade

Update the local bridge in place so its absolute path remains stable:

```bash
cd /absolute/path/to/chrome-agent-bridge
git pull --ff-only
npm ci
npm run install-host
```

Then download and extract the matching new Extension ZIP, replace the previously loaded extension directory, and select **Reload** on `chrome://extensions`. The token remains in the user's private bridge directory and does not need to be renewed for a normal upgrade.

Also update or reinstall the paired `chrome-agent-control` Skill. Plugin installations update it with the bundle; standalone Skill copies must be refreshed separately. Start a new Agent task after the update.

## Uninstall

```bash
cd /absolute/path/to/chrome-agent-bridge
npm run uninstall-host
```

Then remove **Chrome Agent Bridge** from `chrome://extensions`. The authentication file is deliberately left under `~/.chrome-agent-bridge/`; remove that private directory only if the user explicitly wants to delete the saved pairing credential and runtime state.
