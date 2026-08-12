# Clean-room browser capability map

This document records externally observable behavior and public Chrome API equivalents used to guide independent implementation. It does not reproduce or redistribute proprietary extension source code.

## Evidence boundary

The analysis used the locally installed, production-built ChatGPT Chrome extension package only to identify capability boundaries and interoperability shapes. The package contains minified JavaScript rather than the original TypeScript project, source maps, comments, or internal design documents. No cookies, browser storage, credentials, OAuth tokens, page contents, or user history were read during analysis.

The implementation in this repository is independently written against public Chrome Extension, Chrome Debugger Protocol, Native Messaging, and MCP APIs.

The high-level page-control contract also references the MIT-licensed [OpenClaw Browser plugin](https://github.com/openclaw/openclaw/tree/3d707a9b963b91134d01b204638f87841a50787b/extensions/browser). The audited OpenClaw Chrome extension is intentionally a thin CDP transport; its Playwright-backed snapshot/ref/action engine lives in the Browser plugin. Chrome Agent Bridge therefore keeps its own transport and adopts only the relevant semantic contract and actionability ideas, without adding OpenClaw or Playwright as a runtime dependency.

## Observed architecture shape

The installed extension uses a Manifest V3 service worker, a named Native Messaging host, JSON-RPC-style request/response messages, Chrome tab APIs, content scripts, and a generic Chrome Debugger Protocol relay. Its private runtime performs versioned handshakes before browser-control requests are accepted.

Chrome Agent Bridge does not emulate that private handshake, replace the official native host, bypass ChatGPT authentication, or expose an API from the official extension. It supplies its own extension, native host, local bearer token, and MCP contract.

## Capability mapping

| Capability | Public platform primitive | Migration status |
| --- | --- | --- |
| Tab list, create, activate, navigate, close | `chrome.tabs`, `chrome.windows` | Implemented |
| Semantic page snapshot, short-lived refs, and atomic click/fill/press/select | `chrome.scripting.executeScript` + CDP `Input` | Implemented in v0.7 |
| Visible viewport screenshot | `chrome.tabs.captureVisibleTab` | Implemented |
| Tab lifecycle monitoring | `chrome.tabs` events | Implemented |
| Request lifecycle metadata | `chrome.debugger` + CDP `Network` domain | Implemented in v0.4 |
| Window and tab-group management | `chrome.windows`, `chrome.tabGroups` | Planned |
| Download lifecycle metadata | `chrome.downloads` events | Planned |
| Agent cursor and favicon status overlays | content script + Shadow DOM | Planned |
| Viewport emulation | CDP `Emulation` domain | Planned with a narrow allowlist |
| Generic Raw CDP, original results and events | `chrome.debugger.sendCommand` | Implemented in v0.5 as an explicit high-risk surface |
| Script collection, search, debugger, watches, and blackboxing | Public CDP `Debugger` and `Runtime` domains | Implemented in v0.8 over the existing Raw session |
| Source-map discovery, lookup, reconstruction, and diffing | CDP metadata + Source Map v3-compatible mappings | Implemented in v0.8; v4 scope fields are metadata, not full ECMA-426 semantics |
| Metrics, coverage, CPU/heap profiling, heap snapshots, and tracing | Public CDP performance/profiler domains | Implemented in v0.8 with bounded private artifacts |
| Unsanitized bodies, HAR, auth projection, and Fetch interception | Public CDP `Network` and `Fetch` domains | Implemented in v0.8 as explicit high-risk tools; HAR/auth require confirmation |
| Local JS/AST, binary, protocol, and WASM analysis | Public language and wire-format specifications | Implemented in v0.8 without a browser or external service |
| History, bookmarks, top sites | privileged Chrome APIs | Not planned by default due to privacy impact |
| ChatGPT/Codex side-panel and cloud features | product-private runtime | Out of scope |

## Network-monitoring contract

Each monitoring session belongs to one existing HTTP, HTTPS, or file tab. Starting the session attaches Chrome debugging and enables the CDP `Network` domain. Polling returns bounded request, response, completion, failure, and WebSocket lifecycle metadata. Stopping disables the domain and detaches the debugger.

The sanitization boundary is inside the extension service worker:

- URL userinfo and fragments are always removed. Query strings are removed by default and preserved only by the explicit `urlMode="full"` projection option.
- Request and response headers are never copied into bridge events.
- Request bodies, response bodies, WebSocket frames, cookies, security details, and raw CDP request IDs are never copied.
- Raw request IDs are replaced with session-local correlation IDs.
- Events from other tabs are ignored.
- Event count and serialized byte limits evict oldest events and increment `dropped`.

This boundary keeps sensitive data out of Native Messaging, the loopback RPC server, MCP results, logs, and Agent context.

## High-level page-control contract

`browser_snapshot` emits visible interactive elements with semantic roles, accessible names, and short-lived refs. Refs are stored only in the extension service worker, belong to the latest snapshot on one tab, and are invalidated after navigation or any successful action.

`browser_act` resolves a current ref by exact role/name/nth semantics with stable ID, test ID, and selector fallbacks. A click scrolls the target into view, waits two animation frames, checks `document.elementFromPoint`, sends hover/press/release through one extension request, and retries target preparation once if hover shifts the hit target. Keyboard presses use CDP input. Fill and native select use DOM setters plus input/change events; password fields remain rejected.

This high-level engine can reuse the extension's active Raw or network debugger attachment. Otherwise it attaches only for the duration of the mouse or keyboard action and detaches in a cleanup path. Raw CDP remains available for low-level diagnostics, but Agents should not assemble ordinary clicks from separate Raw commands.

## Raw CDP contract

Raw CDP is a separate, explicit session type. It accepts arbitrary CDP method names and JSON params, returns command results without field sanitization, and buffers original CDP event methods, source targets, and params. `Target.attachToTarget` results and `Target.attachedToTarget` events register child session IDs so later commands can address those targets.

Raw CDP can expose cookies, authorization headers, browser storage, page contents, request and response bodies, WebSocket frames, security details, and any other data returned by the chosen CDP command or event. The local authentication token must therefore be treated as a full browser-control credential.

A sanitized network session can reuse an active Raw attachment on the same tab. Agents that only need Raw commands can set `captureEvents=false`, preventing original events from entering the Raw buffer, while the projected stream records only approved metadata. Each Raw session remains tab-scoped, explicitly detached, cursor-paged, and bounded to 1,000 events and a caller-selected total of at most 64 MiB. Individual events and poll pages are capped at 2.5 MB, command results at 3 MB, and Native Messaging frames at 4 MiB. These are transport and lifecycle limits, not CDP method or field allowlists.

The v0.8 high-level analysis tools do not create another Chrome attachment. They send public CDP commands through the selected Raw session and share one serialized event cursor inside the MCP process. Target IDs scope scripts, pauses, requests, traces, and heap chunks so child targets do not overwrite one another. Detaching Raw deletes the corresponding in-memory analysis state.

Trace, heap snapshot, and confirmed HAR exports are bounded private artifacts under the user's bridge directory. HAR and authentication extraction require explicit confirmation. Source-map reconstruction returns safe relative paths as data and never writes recovered trees automatically.

## Migration principles

1. Implement behavior from public API documentation, not copied proprietary code.
2. Prefer narrowly named high-level tools by default; use the explicit Raw CDP tunnel only when its unrestricted behavior is required.
3. Keep every capability tab-scoped and user-visible where Chrome supports that signal.
4. Reject or remove secrets at the extension boundary for high-level tools; document that Raw CDP deliberately preserves original fields.
5. Require explicit stop/cleanup and bounded buffers for long-running observations.
6. Add privileged capabilities in separate releases with tests and documentation.

The detailed clean-room 0.8 migration inventory, including capabilities deliberately excluded because they require external services or privileged runtimes, is in [analysis-tools.md](./analysis-tools.md).
