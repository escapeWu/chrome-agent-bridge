# Sanitized network monitoring

Read this reference only when the task requires request, response, completion, failure, or WebSocket lifecycle metadata.

## Workflow

1. Call `browser_network_start` for the selected tab before the user-requested action.
2. Apply `resourceTypes` or `urlIncludes` filters when they reduce unrelated traffic.
3. Perform only the authorized action that should trigger the request.
4. Page through `browser_network_poll` using its cursor until the needed lifecycle is complete.
5. Always call `browser_network_stop`, including after errors.

Never switch an unrelated control merely to manufacture another request. Do not use Resource Timing, `performance.getEntriesByType("resource")`, or page-level fetch/XHR monkeypatching as the normal path; those observers are incomplete and page-state dependent.

Minimal call shapes:

```text
browser_network_start({tabId, urlMode:"origin_path"|"full", resourceTypes?:["xhr","fetch",...], urlIncludes?:[...]})
browser_network_poll({sessionId, afterCursor, limit?, timeoutMs?})
browser_network_stop({sessionId})
```

Resource type values are lowercase. Reuse each poll result's cursor as the next `afterCursor`.

## Projection boundary

- `browser_network_start` creates a bounded, tab-scoped metadata session.
- Default `urlMode="origin_path"` removes query strings. Use `urlMode="full"` only when the authorized task requires query parameters; they may contain tokens or signatures.
- URL credentials and fragments, headers, bodies, security details, WebSocket frames, cookies, and raw CDP request IDs are never returned.
- `browser_network_poll` returns public request IDs and sanitized lifecycle events. Finished and failed events include `method`, `status` when known, and CDP-monotonic `durationMs`.
- `browser_network_stop` detaches Chrome only when the network session owns the debugger attachment.

## Share a Raw attachment

When the task also requires Raw commands, read [raw-cdp.md](raw-cdp.md). Attach Raw first with `captureEvents=false`, then pass its `sessionId` to `browser_network_start` as `rawSessionId`. Stop the network projection before detaching Raw. Chrome permits only one external debugger owner per target, but these two bridge sessions share that one attachment.
