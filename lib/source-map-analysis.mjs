import { createHash, randomUUID } from "node:crypto";
import { AnyMap, decodedMappings, encodedMap, originalPositionFor, sourceContentFor } from "@jridgewell/trace-mapping";

const MAX_SOURCE_MAP_BYTES = 8 * 1024 * 1024;
const MAX_RECONSTRUCTED_BYTES = 12 * 1024 * 1024;

function normalizeMap(input) {
  let raw;
  try { raw = typeof input === "string" ? input : JSON.stringify(input); }
  catch (error) { throw new Error(`Invalid source map value: ${error.message}`); }
  if (typeof raw !== "string") throw new Error("Source map must be JSON text or an object");
  if (Buffer.byteLength(raw) > MAX_SOURCE_MAP_BYTES) throw new Error(`Source map exceeds ${MAX_SOURCE_MAP_BYTES} bytes`);
  let parsed;
  try { parsed = typeof input === "string" ? JSON.parse(input) : structuredClone(input); }
  catch (error) { throw new Error(`Invalid source map JSON: ${error.message}`); }
  if (!parsed || typeof parsed !== "object" || ![3, 4].includes(parsed.version)) throw new Error("Source map version 3 or 4 is required");
  if (parsed.version === 4 && !parsed.mappings) parsed.mappings = "";
  return { raw, parsed };
}

function mapStats(entry) {
  const lines = decodedMappings(entry.trace);
  let segments = 0;
  const perSource = new Map();
  lines.forEach((line) => line.forEach((segment) => {
    segments += 1;
    if (segment.length >= 4) perSource.set(segment[1], (perSource.get(segment[1]) || 0) + 1);
  }));
  return {
    mapId: entry.id,
    version: entry.map.version,
    file: entry.map.file || null,
    sourceRoot: entry.map.sourceRoot || null,
    sources: (entry.map.sources || []).map((source, index) => ({ source, mappedSegments: perSource.get(index) || 0, hasContent: typeof entry.map.sourcesContent?.[index] === "string" })),
    namesCount: entry.map.names?.length || 0,
    generatedLines: lines.length,
    segmentCount: segments,
    debugId: entry.map.debugId || entry.map.debug_id || null,
    hasV4Scopes: Boolean(entry.map.scopes || entry.map.originalScopes || entry.map.generatedRanges),
  };
}

function sanitizeSourcePath(source, index) {
  const cleaned = String(source || `source-${index}.js`)
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^webpack:\/\/?/i, "")
    .replace(/^[./\\]+/, "")
    .replace(/[<>:"|?*\u0000-\u001f]/g, "_")
    .split(/[\\/]+/)
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return cleaned || `source-${index}.js`;
}

export class SourceMapEngine {
  #maps = new Map();
  #storedBytes = 0;

  parse(input, metadata = {}) {
    const { raw, parsed } = normalizeMap(input);
    const id = `map_${randomUUID()}`;
    const trace = new AnyMap(parsed, metadata.mapUrl || "");
    const flattened = parsed.sections ? encodedMap(trace) : parsed;
    const map = parsed.sections
      ? {
          ...flattened,
          debugId: parsed.debugId || parsed.debug_id,
          scopes: parsed.scopes,
          originalScopes: parsed.originalScopes,
          generatedRanges: parsed.generatedRanges,
        }
      : parsed;
    const entry = { id, rawBytes: Buffer.byteLength(raw), map, trace, metadata, createdAt: new Date().toISOString() };
    this.#maps.set(id, entry);
    this.#storedBytes += entry.rawBytes;
    while (this.#maps.size > 16 || this.#storedBytes > 32 * 1024 * 1024) {
      const oldest = this.#maps.entries().next().value;
      if (!oldest || oldest[0] === id && this.#maps.size === 1) break;
      this.#maps.delete(oldest[0]);
      this.#storedBytes -= oldest[1].rawBytes;
    }
    return { success: true, ...mapStats(entry) };
  }

  get(mapId) {
    const entry = this.#maps.get(mapId);
    if (!entry) throw new Error(`Unknown source map: ${mapId}`);
    return entry;
  }

  coverage(mapId) {
    const entry = this.get(mapId);
    const lines = decodedMappings(entry.trace);
    const sourceLines = new Map();
    let unmappedSegments = 0;
    for (const line of lines) {
      for (const segment of line) {
        if (segment.length < 4) {
          unmappedSegments += 1;
          continue;
        }
        const key = segment[1];
        const set = sourceLines.get(key) || new Set();
        set.add(segment[2] + 1);
        sourceLines.set(key, set);
      }
    }
    const sources = (entry.map.sources || []).map((source, index) => {
      const mappedLines = sourceLines.get(index) || new Set();
      const content = entry.map.sourcesContent?.[index];
      const totalLines = typeof content === "string" ? content.split("\n").length : null;
      return {
        source,
        mappedLineCount: mappedLines.size,
        totalLines,
        coveragePercent: totalLines ? Number((mappedLines.size / totalLines * 100).toFixed(2)) : null,
      };
    });
    return { success: true, mapId, sources, unmappedSegments };
  }

  lookup(mapId, line, column = 0, bias) {
    const entry = this.get(mapId);
    const result = originalPositionFor(entry.trace, { line, column, ...(bias ? { bias } : {}) });
    return { success: true, mapId, generated: { line, column }, original: result };
  }

  reconstruct(mapId, { includeContents = true, maxFiles = 2_000 } = {}) {
    const entry = this.get(mapId);
    let totalBytes = 0;
    const files = [];
    for (let index = 0; index < (entry.map.sources || []).length && files.length < maxFiles; index += 1) {
      const source = entry.map.sources[index];
      const content = sourceContentFor(entry.trace, source, true);
      const bytes = typeof content === "string" ? Buffer.byteLength(content) : 0;
      totalBytes += bytes;
      if (totalBytes > MAX_RECONSTRUCTED_BYTES) throw new Error(`Reconstructed sources exceed ${MAX_RECONSTRUCTED_BYTES} bytes`);
      files.push({ path: sanitizeSourcePath(source, index), source, bytes, ...(includeContents ? { content } : {}) });
    }
    return { success: true, mapId, fileCount: files.length, totalBytes, truncated: files.length < (entry.map.sources || []).length, files };
  }

  parseV4(input, metadata = {}) {
    const parsed = this.parse(input, metadata);
    const entry = this.get(parsed.mapId);
    const scopeFields = {
      scopes: Array.isArray(entry.map.scopes) ? entry.map.scopes.length : entry.map.scopes ? 1 : 0,
      originalScopes: Array.isArray(entry.map.originalScopes) ? entry.map.originalScopes.length : entry.map.originalScopes ? 1 : 0,
      generatedRanges: Array.isArray(entry.map.generatedRanges) ? entry.map.generatedRanges.length : entry.map.generatedRanges ? 1 : 0,
    };
    return { ...parsed, scopeFields, boundary: "V4 debug IDs and scope field presence are preserved; positional lookup uses the compatible mappings field." };
  }

  diff(mapIdA, mapIdB, { lineThreshold = 1 } = {}) {
    const left = this.get(mapIdA);
    const right = this.get(mapIdB);
    const leftSources = new Set(left.map.sources || []);
    const rightSources = new Set(right.map.sources || []);
    const added = [...rightSources].filter((source) => !leftSources.has(source));
    const removed = [...leftSources].filter((source) => !rightSources.has(source));
    const common = [...leftSources].filter((source) => rightSources.has(source));
    const contentChanges = [];
    for (const source of common) {
      const leftContent = sourceContentFor(left.trace, source, true);
      const rightContent = sourceContentFor(right.trace, source, true);
      if (leftContent === rightContent) continue;
      const leftLines = typeof leftContent === "string" ? leftContent.split("\n").length : 0;
      const rightLines = typeof rightContent === "string" ? rightContent.split("\n").length : 0;
      const lineDelta = rightLines - leftLines;
      if (Math.abs(lineDelta) >= lineThreshold || leftContent !== rightContent) {
        contentChanges.push({ source, leftLines, rightLines, lineDelta, leftSha256: leftContent == null ? null : createHash("sha256").update(leftContent).digest("hex"), rightSha256: rightContent == null ? null : createHash("sha256").update(rightContent).digest("hex") });
      }
    }
    return { success: true, mapIdA, mapIdB, added, removed, contentChanges };
  }
}
