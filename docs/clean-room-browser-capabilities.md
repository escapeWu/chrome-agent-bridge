# Clean-room browser capability map

This document records externally observable behavior and public Chrome API equivalents used to guide independent implementation. It does not reproduce or redistribute proprietary extension source code.

## Evidence boundary

The analysis used the locally installed, production-built ChatGPT Chrome extension package only to identify capability boundaries and interoperability shapes. The package contains minified JavaScript rather than the original TypeScript project, source maps, comments, or internal design documents. No cookies, browser storage, credentials, OAuth tokens, page contents, or user history were read during analysis.

The implementation in this repository is independently written against public Chrome Extension, Chrome Debugger Protocol, Native Messaging, and MCP APIs.

## Observed architecture shape

The installed extension uses a Manifest V3 service worker, a named Native Messaging host, JSON-RPC-style request/response messages, Chrome tab APIs, content scripts, and a generic Chrome Debugger Protocol relay. Its private runtime performs versioned handshakes before browser-control requests are accepted.

Chrome Agent Bridge does not emulate that private handshake, replace the official native host, bypass ChatGPT authentication, or expose an API from the official extension. It supplies its own extension, native host, local bearer token, and MCP contract.

## Capability mapping

| Capability | Public platform primitive | Migration status |
| --- | --- | --- |
| Tab list, create, activate, navigate, close | `chrome.tabs`, `chrome.windows` | Implemented |
| Visible page snapshot and safe field interaction | `chrome.scripting.executeScript` | Implemented |
| Visible viewport screenshot | `chrome.tabs.captureVisibleTab` | Implemented |
| Tab lifecycle monitoring | `chrome.tabs` events | Implemented |
| Request lifecycle metadata | `chrome.debugger` + CDP `Network` domain | Implemented in v0.4 |
| Window and tab-group management | `chrome.windows`, `chrome.tabGroups` | Planned |
| Download lifecycle metadata | `chrome.downloads` events | Planned |
| Agent cursor and favicon status overlays | content script + Shadow DOM | Planned |
| Viewport emulation | CDP `Emulation` domain | Planned with a narrow allowlist |
| Generic Raw CDP, original results and events | `chrome.debugger.sendCommand` | Implemented in v0.5 as an explicit high-risk surface |
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

## Raw CDP contract

Raw CDP is a separate, explicit session type. It accepts arbitrary CDP method names and JSON params, returns command results without field sanitization, and buffers original CDP event methods, source targets, and params. `Target.attachToTarget` results and `Target.attachedToTarget` events register child session IDs so later commands can address those targets.

Raw CDP can expose cookies, authorization headers, browser storage, page contents, request and response bodies, WebSocket frames, security details, and any other data returned by the chosen CDP command or event. The local authentication token must therefore be treated as a full browser-control credential.

A sanitized network session can reuse an active Raw attachment on the same tab. Agents that only need Raw commands can set `captureEvents=false`, preventing original events from entering the Raw buffer, while the projected stream records only approved metadata. Each Raw session remains tab-scoped, explicitly detached, cursor-paged, and bounded to 1,000 events, a 3 MB event buffer, and a 3 MB command-result envelope. These are transport and lifecycle limits, not CDP method or field allowlists.

## Migration principles

1. Implement behavior from public API documentation, not copied proprietary code.
2. Prefer narrowly named high-level tools by default; use the explicit Raw CDP tunnel only when its unrestricted behavior is required.
3. Keep every capability tab-scoped and user-visible where Chrome supports that signal.
4. Reject or remove secrets at the extension boundary for high-level tools; document that Raw CDP deliberately preserves original fields.
5. Require explicit stop/cleanup and bounded buffers for long-running observations.
6. Add privileged capabilities in separate releases with tests and documentation.
