# Chrome Agent Bridge

<p align="center">
  <img src="./assets/chrome-agent-bridge-icon-512.png" width="160" alt="Chrome Agent Bridge icon">
</p>

## Project overview

Chrome Agent Bridge connects MCP-compatible Agents to the user's existing Google Chrome session. It runs locally as a Chrome extension, Native Messaging host, and stdio MCP server; it does not launch a remote browser or send browser state through a hosted bridge.

The project provides:

- semantic page snapshots and atomic click, fill, key, and select actions;
- tab navigation, screenshots, and lifecycle monitoring;
- sanitized network monitoring plus an explicit unrestricted Raw CDP channel;
- script collection, debugging, source-map, performance, and opt-in deep-network analysis;
- local JavaScript, binary, protocol, and WebAssembly analysis that does not require Chrome.

The user approves the unpacked extension once in Chrome. Local Agents then authenticate with a long-lived token stored under `~/.chrome-agent-bridge/`. ChatGPT OAuth and the official ChatGPT Chrome extension are not required.

This is a clean-room, MIT-licensed implementation. It does not contain or redistribute OpenAI's proprietary Chrome extension, browser client, native host, or authentication code.

## Architecture

```text
Agent → MCP server → authenticated loopback RPC → Native Messaging host
      → Chrome extension → tabs / scripting / screenshots / sanitized network tools / Raw CDP
```

The browser MCP surface has two levels. The default tools list, navigate, watch, snapshot, screenshot, act on semantic element refs, and monitor sanitized request lifecycle metadata. The explicit Raw CDP tools attach to one tab and forward arbitrary CDP methods, params, results, target sessions, and events without field sanitization. A sanitized network projection can reuse the same Raw attachment when an Agent needs Raw commands without exposing Raw network events to its context.

Version 0.8 also provides clean-room local JavaScript, binary, protocol, source-map, and WASM analysis plus high-level script, debugger, profiler, trace, and opt-in deep-network projections over the existing Raw connection. These additions require no proxy, second browser, privileged service, ADB, Frida, native reverse-engineering suite, WABT, or Binaryen. See the [analysis tool catalog](./docs/analysis-tools.md).

**Raw CDP is equivalent to granting the local bearer token full developer control of an attached tab.** Depending on the commands sent, it can execute JavaScript, read or modify page content, inspect cookies and storage, capture request or response bodies, intercept traffic, and control child targets. Do not expose the loopback service or token to another user or machine.

## Reference projects and specifications

- [OpenClaw Browser plugin](https://github.com/openclaw/openclaw/tree/3d707a9b963b91134d01b204638f87841a50787b/extensions/browser) — informed the semantic `snapshot → ref → act → snapshot` contract, interactive-role coverage, and actionability checks. OpenClaw is MIT-licensed, but it is not bundled, forked, or required at runtime.
- [JSHookMCP](https://github.com/vmoranv/jshookmcp) — its public tool catalog was reviewed to identify useful analysis capabilities that could run without its browser, proxy, daemon, ADB, Frida, or native reverse-engineering services. The selected capabilities were independently reimplemented from public language and protocol specifications. JSHookMCP is AGPL-licensed; none of its source code is copied or bundled here.
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) — provides the MCP server transport and tool registration API used by the local Agent bridge.
- [Chrome Extensions](https://developer.chrome.com/docs/extensions/) and the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) — define the public browser, Native Messaging, debugger, page, network, runtime, and profiler contracts used by the implementation.

The locally installed production ChatGPT Chrome extension was used only to understand externally observable capability boundaries. It was not treated as source code or a reusable implementation. Detailed provenance and clean-room boundaries are recorded in [docs/clean-room-browser-capabilities.md](./docs/clean-room-browser-capabilities.md) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Requirements

- Node.js 18 or newer
- Google Chrome on macOS or Linux
- An MCP-compatible agent

Windows native-host installation is not implemented in the initial release.

## Install

For an Agent-executable checklist, MCP configuration, verification steps, upgrades, and recovery guidance, see [Install Chrome Agent Bridge for an Agent](./docs/agent-installation.md).

### Install the released extension ZIP

1. Download `chrome-agent-bridge-extension-vX.Y.Z.zip` from [GitHub Releases](https://github.com/escapeWu/chrome-agent-bridge/releases).
2. Extract the ZIP to a permanent local directory.
3. Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted directory.

The release manifest carries a public development key, so every unpacked release uses the stable extension ID `hkedmoboloodflgcaidimhddljdnndcd`. The ZIP is not directly installable: Chrome requires it to be extracted before **Load unpacked**.

### Install the local Agent bridge

```bash
git clone https://github.com/escapeWu/chrome-agent-bridge.git
cd chrome-agent-bridge
npm ci
npm run install-host
```

Reload the extension on `chrome://extensions`. The extension and native host reconnect automatically. For a custom development build with a different ID, pass `--extension-id ID` explicitly.

### Install the paired Agent Skill

Installing only the Extension ZIP and MCP server is incomplete for Agent use. Also install `skills/chrome-agent-control` so the Agent follows the required connection, tab-scoping, network-listening, Raw CDP, cleanup, and confirmation workflows.

The Codex plugin bundle installs the MCP registration and Skill together. When configuring `mcp/server.mjs` as a standalone MCP server, install the Skill separately. See the exact Agent checklist in [docs/agent-installation.md](./docs/agent-installation.md).

### Pairing token

Click the extension toolbar icon to open its local pairing window. The window shows a masked, long-lived authentication token with controls to reveal, copy, or renew it. Renew requires two clicks and invalidates the previous token immediately.

The token is generated by the native host and stored only in `~/.chrome-agent-bridge/auth.json` with user-only permissions. It is not stored in Chrome Sync, the extension package, Git, or GitHub Releases. Local agents discover it automatically. A separately configured local agent can receive the copied value through `CHROME_AGENT_BRIDGE_TOKEN`.

## Agent quick start

Agents can use this section as an installation and connection checklist:

1. Verify Node.js 18+ and Google Chrome are installed.
2. Run `npm ci` and `npm run install-host` in the repository root. The released extension ID is built in.
3. Ask the user to download and extract the Extension ZIP, then load its extracted directory from `chrome://extensions` with **Developer mode** enabled. This is the only required user-visible approval step.
4. Ask the user to reload **Chrome Agent Bridge** after source, manifest, or native-host installation changes.
5. Add `mcp/server.mjs` to the Agent's MCP configuration using an absolute filesystem path, or install this repository as a Codex plugin. Copy the ready-to-use configuration from [docs/agent-installation.md](./docs/agent-installation.md).
6. Install and enable the paired `chrome-agent-control` Skill. Do not treat MCP configuration alone as a complete Agent installation.
7. Call `browser_status`, then `browser_list_tabs`. Do not begin browser actions until the bridge reports connected.

For page interaction, take `browser_snapshot`, act once with `browser_act` using a returned ref, then take a new snapshot and verify. Refs are deliberately short-lived and invalidated after an action or navigation. A high-level click performs its full CDP mouse sequence atomically inside the extension; do not split `mouseMoved`, `mousePressed`, and `mouseReleased` across Raw MCP calls. For tab monitoring, call `browser_watch_events` with the previous cursor and, when useful, a specific `tabId`. Start sanitized request monitoring before the intended UI action, page through `browser_network_poll`, and always finish with `browser_network_stop`. When Raw commands and a safe network summary are both required, attach Raw with `captureEvents=false` and pass its session ID to `browser_network_start` as `rawSessionId`; this shares one Chrome debugger attachment. Do not fall back to Resource Timing or page-level fetch/XHR hooks merely because the page's performance buffer is full.

Never submit forms, purchase, publish, delete, send messages, or change permissions without the user's explicit approval. The high-level fill tool rejects password fields, but Raw CDP bypasses those high-level guardrails and may expose cookies, storage, credentials, and private page content.

## Connect an MCP agent

Use an absolute path when configuring a standalone MCP client:

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

The local Agent reads `~/.chrome-agent-bridge/auth.json` automatically. Set `CHROME_AGENT_BRIDGE_TOKEN` only when configuring a separate local process with a token copied from the extension popup.

The repository is also a Codex plugin: `.codex-plugin/plugin.json` registers the MCP server and the `chrome-agent-control` skill.

**Standalone MCP clients must install the paired Skill separately.** The Extension ZIP contains only the Chrome extension, and an MCP configuration exposes tools without teaching the Agent the required workflow. Follow [Install Chrome Agent Bridge for an Agent](./docs/agent-installation.md).

## Tools

The server exposes 96 tools: 19 browser primitives and 77 analysis tools grouped into three batches. The full names, prerequisites, exclusions, and recommended call chains are in [docs/analysis-tools.md](./docs/analysis-tools.md).

Browser primitives:

- `browser_status`
- `browser_list_tabs`
- `browser_open_tab`
- `browser_activate_tab`
- `browser_close_tab`
- `browser_navigate`
- `browser_snapshot`
- `browser_screenshot`
- `browser_act`
- `browser_click`
- `browser_fill`
- `browser_watch_events`
- `browser_network_start`
- `browser_network_poll`
- `browser_network_stop`
- `browser_cdp_attach`
- `browser_cdp_send`
- `browser_cdp_events`
- `browser_cdp_detach`

Prefer `browser_snapshot → browser_act(ref) → browser_snapshot`. `browser_click` and `browser_fill` remain selector-based compatibility tools.

Analysis groups:

- Local JavaScript inspection, deobfuscation, AST transforms, and bounded crypto test vectors
- Local binary, Protobuf, HTTP/2, gRPC, protocol inference, and WASM inspection
- Raw-backed script collection, source maps, debugger, coverage, CPU/heap profiling, tracing, exceptions, and explicitly sensitive deep-network inspection

Local analysis does not require Chrome. Raw-backed analysis starts from `browser_cdp_attach({captureEvents:true})` and must end with `browser_cdp_detach`; detaching also clears that session's MCP-side analysis cache.

## Security model

- Native Messaging only accepts the extension ID placed in the installed host manifest.
- The installer generates a private launcher containing absolute Node.js and host paths, so Chrome does not depend on the terminal's `PATH`.
- The native host listens only on `127.0.0.1` and requires a long-lived random bearer token for every RPC request.
- The token is stored in `~/.chrome-agent-bridge/auth.json` with user-only permissions. It has no automatic expiry and remains valid until the user selects **Renew** in the extension popup.
- Runtime connection data is stored separately in `~/.chrome-agent-bridge/runtime.json`; it does not contain the token.
- Renewing the token atomically replaces the local credential and immediately rejects the previous token.
- Password inputs are rejected by `browser_fill`; Raw CDP commands are not restricted by that check.
- Browser-internal URLs cannot be inspected or scripted.
- The default high-level tools do not read cookies, saved passwords, local storage, or session storage. Raw CDP can access data exposed by Chrome's CDP implementation.
- Network monitoring uses Chrome's user-visible `debugger` permission and attaches only to the selected tab for the lifetime of a network session.
- Network events contain lifecycle metadata only. Userinfo, URL fragments, headers, request bodies, response bodies, security details, and raw CDP request IDs are not returned. Query strings are removed by default and preserved only with explicit `urlMode="full"` because they may contain tokens or signatures.
- Network sessions have bounded event and byte buffers, monotonically increasing cursors, tab isolation, and explicit stop/detach behavior.
- Raw CDP accepts any method and JSON params and returns original results and events, including sensitive fields. Per-session event storage is caller-bounded up to 64 MiB and 1,000 events; individual events and poll pages are capped at 2.5 MB, and command results at 3 MB, below the 4 MiB Native Messaging envelope.
- Set `captureEvents=false` when Raw is needed for commands but original events are not required. A sanitized network session can reuse that Raw attachment through `rawSessionId`; stopping the projection leaves Raw attached, while detaching Raw terminates its active projection.
- Raw-backed analysis retains bounded scripts, debugger values, and request metadata only in the MCP process for the attached session. `browser_cdp_detach` clears that in-memory state. Trace, heap, and confirmed HAR exports are private local artifacts under `~/.chrome-agent-bridge/artifacts/` and remain until removed.
- `network_export_har` and `network_extract_auth` require explicit `confirmed=true`. The latter returns live secrets; never include them in logs, commits, or normal Agent summaries.
- Agents should require user confirmation before submitting, purchasing, publishing, deleting, sending, or changing permissions.

The clean-room capability analysis and migration boundaries are documented in [docs/clean-room-browser-capabilities.md](./docs/clean-room-browser-capabilities.md).

This is an early developer release. Review the requested tab and action before allowing an agent to operate a signed-in site.

## Development

```bash
npm test
npm run check
npm run build:extension
```

Validate the Codex plugin and Skill with the corresponding Codex creator validators before publishing changes.

Pushing a matching `vX.Y.Z` tag runs the release workflow, validates package, plugin, and extension versions, and attaches the allowlisted Extension ZIP to a GitHub Release.

## Uninstall the native host

```bash
npm run uninstall-host
```

Then remove the unpacked extension from `chrome://extensions`.

## License

MIT
