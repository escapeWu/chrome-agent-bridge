# Source maps

Source-map parsing, lookup, coverage, reconstruction, and diffing are local. Discovery and authenticated page fetch require Raw CDP with `captureEvents=true`.

## Page workflow

1. Attach Raw and call `sourcemap_discover({sessionId})`.
2. For an inline map, decode or pass its JSON as `mapText`.
3. For a page map URL, call `sourcemap_fetch_and_parse({sessionId,sourceMapUrl})`. The selected page performs authenticated `fetch`; use only an authorized URL.
4. Keep the returned `mapId` for follow-up calls.
5. Detach Raw when browser collection is complete. Local `mapId` operations remain available in the current MCP process.

## Local operations

- `sourcemap_coverage({mapId})`: mapped-line projection by source.
- `sourcemap_lookup({mapId,line,column})`: generated to original position.
- `sourcemap_reconstruct_tree({mapId,includeContents:false})`: safe relative paths; enable contents only when needed.
- `sourcemap_parse_v4({mapText})`: compatible mappings plus debug-ID/scope-field metadata, not full ECMA-426 scope semantics.
- `sourcemap_diff({mapIdA,mapIdB})`: source membership and content hash/line differences.

Parsed maps are bounded and held only in the current MCP process with eviction. Reconstructed paths are returned as data; this tool does not write recovered source trees automatically.
