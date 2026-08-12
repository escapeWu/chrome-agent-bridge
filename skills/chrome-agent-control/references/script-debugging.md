# Script collection and debugging

Read [raw-cdp.md](raw-cdp.md) first. Attach with `captureEvents=true`; these tools share and consume one Raw event cursor in the MCP process.

## Scripts

1. Call `collect_code({sessionId,...})` after attaching Raw. It enables `Debugger`, indexes `scriptParsed` events, and optionally fetches bounded sources.
2. Use `search_in_scripts({collectionId:sessionId,...})` or `extract_function_tree({collectionId:sessionId,...})`.
3. Use `webpack_enumerate` only when runtime Webpack module inspection is required; it injects a bounded runtime probe.

## Debugger

1. Enable with `debugger_lifecycle({sessionId,action:"enable"})`.
2. Add source, URL, XHR, event, or exception breakpoints with `breakpoint`.
3. Trigger only the authorized page action.
4. Use `debugger_wait_for_paused` or `debugger_capture_hit`.
5. Inspect with `get_call_stack`, `debugger_evaluate`, `get_object_properties`, or `get_scope_variables_enhanced`.
6. Use `debugger_step`, `debugger_resume`, or `debugger_run_to_location` deliberately.
7. Remove breakpoints, disable the debugger, then detach Raw.

`watch` manages expressions; `blackbox_add`, `blackbox_add_common`, and `blackbox_list` manage skip patterns. `debugger_session` saves only local metadata and does not silently recreate breakpoints.

Debugger evaluation executes JavaScript in the page. Treat returned remote values and scopes as unsanitized private data.
