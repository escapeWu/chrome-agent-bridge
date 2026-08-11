# Chrome Agent Bridge

Chrome Agent Bridge is a small, local bridge that lets MCP-compatible agents interact with user-approved Google Chrome tabs. It is a clean-room, MIT-licensed implementation built from public Chrome Native Messaging and Model Context Protocol APIs.

It does not contain or redistribute OpenAI's proprietary Chrome extension, browser client, or native host.

## Architecture

```text
Agent → MCP server → authenticated loopback RPC → Native Messaging host
      → Chrome extension → tabs / scripting / screenshots
```

The MCP surface is intentionally narrow: list, open, activate, and navigate tabs; read a visible snapshot; take a screenshot; click; and fill non-password fields. It does not expose cookies, passwords, browser storage, arbitrary JavaScript, or raw CDP.

## Requirements

- Node.js 18 or newer
- Google Chrome on macOS or Linux
- An MCP-compatible agent

Windows native-host installation is not implemented in the initial release.

## Install

```bash
git clone https://github.com/escapeWu/chrome-agent-bridge.git
cd chrome-agent-bridge
npm install
```

Open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the repository's `extension/` directory. Copy the extension ID shown by Chrome.

Install the Native Messaging manifest using that ID:

```bash
npm run install-host -- --extension-id YOUR_EXTENSION_ID
```

Reload the extension. Click its toolbar icon once if the native connection has not started.

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

The repository is also a Codex plugin: `.codex-plugin/plugin.json` registers the MCP server and the `chrome-agent-control` skill.

## Tools

- `browser_status`
- `browser_list_tabs`
- `browser_open_tab`
- `browser_activate_tab`
- `browser_navigate`
- `browser_snapshot`
- `browser_screenshot`
- `browser_click`
- `browser_fill`

Call `browser_snapshot` before clicking or filling. Use selectors from the latest snapshot and verify state again after each action.

## Security model

- Native Messaging only accepts the extension ID placed in the installed host manifest.
- The native host listens on `127.0.0.1` with a random per-process bearer token.
- Runtime connection data is stored in `~/.chrome-agent-bridge/runtime.json` with user-only permissions.
- Password inputs are rejected in the extension.
- Browser-internal URLs cannot be inspected or scripted.
- The bridge never reads cookies, saved passwords, local storage, or session storage.
- Agents should require user confirmation before submitting, purchasing, publishing, deleting, sending, or changing permissions.

This is an early developer release. Review the requested tab and action before allowing an agent to operate a signed-in site.

## Development

```bash
npm test
npm run check
```

Validate the Codex plugin and Skill with the corresponding Codex creator validators before publishing changes.

## Uninstall the native host

```bash
npm run uninstall-host
```

Then remove the unpacked extension from `chrome://extensions`.

## License

MIT
