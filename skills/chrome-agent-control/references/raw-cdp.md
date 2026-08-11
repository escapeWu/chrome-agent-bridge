# Raw CDP

Read this reference only when the user-authorized task requires arbitrary Chrome DevTools Protocol commands or original CDP events that high-level tools cannot provide.

## Choose the capture mode

- Use `captureEvents=false` for Raw commands without original event capture. Prefer this mode when a sanitized network projection is sufficient.
- Use `captureEvents=true` only when the task explicitly requires original, unsanitized CDP events.

## Workflow

1. Call `browser_cdp_attach` for the selected tab with the chosen `captureEvents` mode.
2. Call `browser_cdp_send` with the authorized CDP method and JSON params.
3. When capture is enabled, page through `browser_cdp_events` using its cursor.
4. Always call `browser_cdp_detach`, including after errors.

Use `targetSessionId` only after `Target.attachToTarget` returns it or a `Target.attachedToTarget` event exposes it within the same Raw session.

Minimal call shapes:

```text
browser_cdp_attach({tabId, captureEvents:false|true})
browser_cdp_send({sessionId, method, params, targetSessionId?})
browser_cdp_events({sessionId, afterCursor, limit?, timeoutMs?})
browser_cdp_detach({sessionId})
```

For Raw commands plus sanitized network metadata, also read [network-monitoring.md](network-monitoring.md). Attach Raw with `captureEvents=false`, start the network projection with `rawSessionId`, stop the projection, then detach Raw.

## Safety boundary

Raw CDP has no method or field allowlist and does not sanitize command results or captured events. It may expose or modify cookies, credentials, storage, private page content, request and response bodies, WebSocket frames, permissions, and child targets. Buffer and transport size limits are not privacy controls.

- Restrict every command to the selected tab and exact authorized task.
- Do not echo or persist secrets returned by Raw CDP.
- Do not use Raw CDP to bypass confirmation or password protections.
- Detach immediately after the required work.
