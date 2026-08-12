# Performance and deep network analysis

Read [raw-cdp.md](raw-cdp.md). Attach with `captureEvents=true` and raise `maxBytes` only for an authorized trace or heap snapshot. These tools expose unsanitized data.

## Performance

- `performance_get_metrics`: current CDP metrics.
- `performance_coverage`: `start` before the action, then `stop`.
- `profiler_cpu` / `profiler_heap_sampling`: paired `start` and `stop` calls.
- `console_get_exceptions`: consume captured exception events.
- `performance_trace`: paired start/stop; stop writes a private local JSON artifact.
- `performance_take_heap_snapshot`: writes a private `.heapsnapshot` artifact and fails if capture was truncated.

Trace and heap artifacts are stored under `~/.chrome-agent-bridge/artifacts/` with user-only permissions. Remove them when no longer needed.

## Unsanitized network

Enable `Network` through Raw before the triggering action. Then use:

- `network_get_stats`: summarize captured Raw requests.
- `network_get_response_body`: original CDP request ID and full body.
- `network_export_har`: persists headers and post data; requires `confirmed=true`.
- `network_extract_auth`: returns tokens/cookies; requires `confirmed=true` for the exact request.
- `network_intercept`: enable → poll → continue/fail/fulfill every paused request → disable.

Prefer sanitized `browser_network_*` tools whenever bodies, headers, or original IDs are unnecessary. Never leave Fetch interception enabled or requests paused during cleanup.
