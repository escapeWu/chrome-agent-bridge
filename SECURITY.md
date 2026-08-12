# Security policy

Please report vulnerabilities privately through GitHub's **Report a vulnerability** feature when it is enabled for this repository. Do not include credentials, cookies, private page content, or session tokens in an issue.

The bridge is intended for local, user-present automation. It is not a remote browser-control service and must not be exposed beyond the loopback interface.

The long-lived bearer token in `~/.chrome-agent-bridge/auth.json` grants control through the local bridge. With Raw CDP enabled, that includes arbitrary developer-protocol commands that may read credentials, cookies, storage, page contents, request or response bodies, and other sensitive browser data. Keep the file private, never commit or log the token or Raw results containing secrets, and use **Renew** in the extension popup immediately if the token may have been disclosed. Renewal invalidates the previous token.

Never bind the RPC server beyond `127.0.0.1`, forward its port, place it behind a public proxy, or share its bearer token. Raw CDP is designed for a user-present local Agent operating an explicitly selected tab, not unattended or remote browser administration.

Debugger scopes, evaluated values, script sources, request headers, bodies, HAR exports, authentication findings, traces, and heap snapshots may contain private data or live credentials. Raw-backed analysis keeps bounded state in the local MCP process until `browser_cdp_detach`; detaching clears that cache. Artifact tools write user-only files under `~/.chrome-agent-bridge/artifacts/`, which the user or Agent must remove when no longer needed.

`network_export_har` and `network_extract_auth` require explicit confirmation. Do not weaken or bypass those checks. `network_intercept` can pause live requests; always disable it and detach Raw in cleanup paths.
