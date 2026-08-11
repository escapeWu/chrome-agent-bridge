# Security policy

Please report vulnerabilities privately through GitHub's **Report a vulnerability** feature when it is enabled for this repository. Do not include credentials, cookies, private page content, or session tokens in an issue.

The bridge is intended for local, user-present automation. It is not a remote browser-control service and must not be exposed beyond the loopback interface.

The long-lived bearer token in `~/.chrome-agent-bridge/auth.json` grants control through the local bridge. Keep the file private, never commit or log the token, and use **Renew** in the extension popup immediately if the token may have been disclosed. Renewal invalidates the previous token.
