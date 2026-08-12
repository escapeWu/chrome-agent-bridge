import { Worker } from "node:worker_threads";
import { parse } from "acorn";
import * as walk from "acorn-walk";

const CRYPTO_PATTERNS = [
  ["AES", /\b(?:AES|aes|SubBytes|MixColumns|Rijndael)\b/g],
  ["RSA", /\b(?:RSA|rsa|modPow|publicExponent|privateExponent)\b/g],
  ["SHA-1", /\b(?:SHA-?1|sha1)\b/g],
  ["SHA-2", /\b(?:SHA-?(?:224|256|384|512)|sha(?:224|256|384|512))\b/g],
  ["MD5", /\b(?:MD5|md5)\b/g],
  ["HMAC", /\b(?:HMAC|hmac)\b/g],
  ["PBKDF2", /\b(?:PBKDF2|pbkdf2)\b/g],
  ["scrypt", /\bscrypt\b/gi],
  ["Argon2", /\bargon2\b/gi],
  ["RC4", /\b(?:RC4|rc4|arc4)\b/g],
  ["WebCrypto", /\b(?:crypto\.subtle|SubtleCrypto)\b/g],
  ["JWT", /\b(?:jwt|jsonwebtoken|JWS|JWE)\b/gi],
];

const SOURCE_PATTERNS = [
  ["location", /\b(?:location\.(?:href|search|hash)|document\.URL)\b/g],
  ["storage", /\b(?:localStorage|sessionStorage)\.(?:getItem|key)\b/g],
  ["message", /\b(?:event|e)\.data\b/g],
  ["form", /\b(?:value|FormData)\b/g],
  ["network", /\b(?:response\.(?:text|json)|fetch\s*\()\b/g],
];

const SINK_PATTERNS = [
  ["html", /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/g],
  ["dynamic-code", /\b(?:eval|Function|setTimeout|setInterval)\s*\(/g],
  ["navigation", /\b(?:location\.(?:href|assign|replace)|window\.open)\b/g],
  ["command", /\b(?:exec|execSync|spawn|spawnSync)\s*\(/g],
  ["database", /\b(?:query|execute)\s*\(/g],
];

function parseCode(code) {
  const options = {
    ecmaVersion: "latest",
    allowHashBang: true,
    allowAwaitOutsideFunction: true,
    locations: true,
    ranges: true,
  };
  try {
    return parse(code, { ...options, sourceType: "module" });
  } catch (moduleError) {
    try {
      return parse(code, { ...options, sourceType: "script" });
    } catch (scriptError) {
      const error = new Error(`JavaScript parse failed: ${scriptError.message}`);
      error.code = "analysis_parse_error";
      error.cause = moduleError;
      throw error;
    }
  }
}

function countMatches(code, regex) {
  regex.lastIndex = 0;
  return [...code.matchAll(regex)].length;
}

function lineOf(code, offset) {
  return code.slice(0, Math.max(0, offset)).split("\n").length;
}

function locationFor(node) {
  return node?.loc
    ? { line: node.loc.start.line, column: node.loc.start.column }
    : undefined;
}

function nodeSummary(node) {
  const result = {};
  for (const key of ["name", "operator", "kind", "computed", "optional", "async", "generator"]) {
    if (["string", "number", "boolean"].includes(typeof node?.[key])) result[key] = node[key];
  }
  if (node?.callee?.type) result.calleeType = node.callee.type;
  if (node?.property?.type === "Identifier") result.property = node.property.name;
  if (node?.value != null && ["string", "number", "boolean"].includes(typeof node.value)) {
    result.value = node.value;
  }
  return result;
}

function identifierName(node) {
  if (!node) return null;
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression") {
    const object = identifierName(node.object);
    const property = node.computed
      ? node.property?.type === "Literal"
        ? String(node.property.value)
        : null
      : identifierName(node.property);
    return object && property ? `${object}.${property}` : object;
  }
  return null;
}

function functionName(node, ancestors) {
  if (node.id?.name) return node.id.name;
  const parent = ancestors.at(-2);
  if (parent?.type === "VariableDeclarator") return identifierName(parent.id) || "<anonymous>";
  if (parent?.type === "Property") return identifierName(parent.key) || String(parent.key?.value || "<anonymous>");
  if (parent?.type === "AssignmentExpression") return identifierName(parent.left) || "<anonymous>";
  return "<anonymous>";
}

export function understandCode(code, { focus = "all" } = {}) {
  const ast = parseCode(code);
  const functions = [];
  const imports = [];
  const calls = new Map();
  const globals = new Set();
  let branches = 0;
  let loops = 0;
  let classes = 0;

  walk.ancestor(ast, {
    FunctionDeclaration(node, ancestors) {
      functions.push({
        name: functionName(node, ancestors),
        kind: "function",
        params: node.params.length,
        async: node.async,
        location: locationFor(node),
      });
    },
    FunctionExpression(node, ancestors) {
      functions.push({
        name: functionName(node, ancestors),
        kind: "function-expression",
        params: node.params.length,
        async: node.async,
        location: locationFor(node),
      });
    },
    ArrowFunctionExpression(node, ancestors) {
      functions.push({
        name: functionName(node, ancestors),
        kind: "arrow",
        params: node.params.length,
        async: node.async,
        location: locationFor(node),
      });
    },
    ImportDeclaration(node) {
      imports.push({ source: node.source.value, names: node.specifiers.map((item) => item.local.name) });
    },
    CallExpression(node) {
      const name = identifierName(node.callee) || "<dynamic>";
      calls.set(name, (calls.get(name) || 0) + 1);
    },
    IfStatement() {
      branches += 1;
    },
    ConditionalExpression() {
      branches += 1;
    },
    SwitchCase() {
      branches += 1;
    },
    ForStatement() {
      loops += 1;
    },
    ForInStatement() {
      loops += 1;
    },
    ForOfStatement() {
      loops += 1;
    },
    WhileStatement() {
      loops += 1;
    },
    DoWhileStatement() {
      loops += 1;
    },
    ClassDeclaration() {
      classes += 1;
    },
    Identifier(node, ancestors) {
      const parent = ancestors.at(-2);
      if (
        parent?.type === "MemberExpression" && parent.property === node && !parent.computed ||
        parent?.type === "Property" && parent.key === node && !parent.computed ||
        parent?.type === "VariableDeclarator" && parent.id === node ||
        parent?.type?.startsWith("Function") && parent.params?.includes(node)
      ) return;
      if (["window", "document", "globalThis", "fetch", "crypto", "WebAssembly"].includes(node.name)) {
        globals.add(node.name);
      }
    },
  });

  const result = {
    success: true,
    focus,
    size: { bytes: Buffer.byteLength(code), lines: code.split("\n").length },
    structure: {
      functions: functions.slice(0, 500),
      functionCount: functions.length,
      classes,
      imports,
      branches,
      loops,
      estimatedCyclomaticComplexity: 1 + branches + loops,
      globals: [...globals].sort(),
    },
    calls: [...calls.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 100)
      .map(([name, count]) => ({ name, count })),
  };
  if (focus === "security" || focus === "all") result.security = analysisSecurityScan(code);
  return result;
}

export function analysisAstMatch(code, { nodeType, filter = {}, maxResults = 50 } = {}) {
  if (!nodeType) throw new Error("nodeType is required");
  const ast = parseCode(code);
  const matches = [];
  walk.full(ast, (node) => {
    if (matches.length >= maxResults || node.type !== nodeType) return;
    for (const [path, expected] of Object.entries(filter || {})) {
      let current = node;
      for (const part of path.split(".")) current = current?.[part];
      if (String(current) !== String(expected)) return;
    }
    matches.push({
      type: node.type,
      start: node.start,
      end: node.end,
      location: locationFor(node),
      code: code.slice(node.start, node.end),
      properties: nodeSummary(node),
    });
  });
  return { success: true, nodeType, total: matches.length, matches };
}

export function detectCrypto(code) {
  const algorithms = CRYPTO_PATTERNS.map(([algorithm, regex]) => ({
    algorithm,
    count: countMatches(code, regex),
  })).filter((item) => item.count > 0);
  const operations = [
    ["randomness", /\b(?:crypto\.getRandomValues|randomBytes|Math\.random)\b/g],
    ["encoding", /\b(?:btoa|atob|Base64|TextEncoder|TextDecoder)\b/g],
    ["key-material", /\b(?:secret|privateKey|publicKey|apiKey|nonce|iv|salt)\b/gi],
    ["signing", /\b(?:sign|verify|signature)\b/gi],
  ].map(([kind, regex]) => ({ kind, count: countMatches(code, regex) })).filter((item) => item.count);
  return { success: true, detected: algorithms.length > 0, algorithms, operations };
}

export function detectObfuscation(code) {
  const identifiers = code.match(/\b[A-Za-z_$][\w$]*\b/g) || [];
  const shortIdentifiers = identifiers.filter((value) => value.length <= 2).length;
  const longHexEscapes = countMatches(code, /(?:\\x[0-9a-fA-F]{2}){3,}/g);
  const unicodeEscapes = countMatches(code, /(?:\\u[0-9a-fA-F]{4}){2,}/g);
  const stringArrays = countMatches(code, /\[(?:\s*['"][^'"]*['"]\s*,){4,}/g);
  const dynamicCode = countMatches(code, /\b(?:eval|Function)\s*\(/g);
  const controlFlow = countMatches(code, /while\s*\(\s*(?:true|!!\[\])\s*\)\s*\{\s*switch\s*\(/g);
  const packed = countMatches(code, /eval\(function\(p,a,c,k,e,[rd]\)/g);
  const signals = [
    ["hex-string-escapes", longHexEscapes, 2],
    ["unicode-string-escapes", unicodeEscapes, 2],
    ["string-array", stringArrays, 2],
    ["dynamic-code", dynamicCode, 1],
    ["control-flow-flattening", controlFlow, 4],
    ["packer-signature", packed, 5],
    ["short-identifiers", identifiers.length > 50 && shortIdentifiers / identifiers.length > 0.45 ? 1 : 0, 2],
  ].filter(([, count]) => count > 0).map(([type, count, weight]) => ({ type, count, weight }));
  const score = Math.min(100, signals.reduce((sum, item) => sum + item.count * item.weight * 8, 0));
  return { success: true, obfuscated: score >= 25, score, signals };
}

export function analysisSecurityScan(code) {
  parseCode(code);
  const risks = [];
  const addRegex = (id, severity, regex, message, recommendation) => {
    regex.lastIndex = 0;
    for (const match of code.matchAll(regex)) {
      risks.push({
        id,
        severity,
        message,
        recommendation,
        line: lineOf(code, match.index),
        evidence: match[0].slice(0, 180),
      });
      if (risks.length >= 500) return;
    }
  };
  addRegex("dynamic-code", "high", /\b(?:eval|Function)\s*\(/g, "Dynamic code execution", "Avoid evaluating strings as code.");
  addRegex("html-injection", "high", /\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/g, "Potential HTML injection sink", "Use textContent or a reviewed sanitizer.");
  addRegex("weak-random", "medium", /\bMath\.random\s*\(/g, "Math.random is not cryptographically secure", "Use crypto.getRandomValues for security-sensitive values.");
  addRegex("hardcoded-secret", "high", /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"\n]{8,}['"]/gi, "Possible hard-coded credential", "Load secrets from a protected runtime source.");
  addRegex("insecure-http", "medium", /['"]http:\/\/[^'"\s]+['"]/gi, "Plain HTTP endpoint", "Use HTTPS where the endpoint supports it.");
  addRegex("prototype-pollution", "high", /\b(?:__proto__|constructor\s*\[\s*['"]prototype['"])/g, "Prototype mutation pattern", "Reject dangerous keys and use safe merge logic.");
  return {
    success: true,
    riskCount: risks.length,
    severities: Object.fromEntries(["critical", "high", "medium", "low"].map((level) => [level, risks.filter((risk) => risk.severity === level).length])),
    risks,
    boundary: "Static heuristic findings require human verification.",
  };
}

export function analysisDataFlow(code) {
  parseCode(code);
  const sources = [];
  const sinks = [];
  for (const [kind, regex] of SOURCE_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of code.matchAll(regex)) sources.push({ kind, line: lineOf(code, match.index), expression: match[0] });
  }
  for (const [kind, regex] of SINK_PATTERNS) {
    regex.lastIndex = 0;
    for (const match of code.matchAll(regex)) sinks.push({ kind, line: lineOf(code, match.index), expression: match[0] });
  }
  const assignments = [];
  const ast = parseCode(code);
  walk.simple(ast, {
    VariableDeclarator(node) {
      const target = identifierName(node.id);
      if (!target || !node.init) return;
      const value = code.slice(node.init.start, node.init.end);
      if (SOURCE_PATTERNS.some(([, regex]) => (regex.lastIndex = 0, regex.test(value)))) {
        assignments.push({ target, source: value, line: node.loc.start.line });
      }
    },
    AssignmentExpression(node) {
      const target = identifierName(node.left);
      if (!target) return;
      const value = code.slice(node.right.start, node.right.end);
      if (SOURCE_PATTERNS.some(([, regex]) => (regex.lastIndex = 0, regex.test(value)))) {
        assignments.push({ target, source: value, line: node.loc.start.line });
      }
    },
  });
  const paths = [];
  for (const assignment of assignments) {
    const escaped = assignment.target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const sink of sinks) {
      const line = code.split("\n")[sink.line - 1] || "";
      if (new RegExp(`\\b${escaped}\\b`).test(line)) paths.push({ source: assignment, sink });
    }
  }
  return { success: true, sources, sinks, assignments, paths, boundary: "Shallow intra-file taint projection; aliases and runtime flows may be missed." };
}

export function decodeStringArrays(code) {
  const ast = parseCode(code);
  const arrays = new Map();
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.init?.type !== "ArrayExpression") return;
      const values = node.init.elements.map((item) => item?.type === "Literal" ? item.value : undefined);
      if (values.length >= 2 && values.every((value) => ["string", "number", "boolean"].includes(typeof value))) {
        arrays.set(node.id.name, values);
      }
    },
  });
  const replacements = [];
  walk.simple(ast, {
    MemberExpression(node) {
      if (node.object.type !== "Identifier" || !node.computed || node.property.type !== "Literal") return;
      const values = arrays.get(node.object.name);
      const index = Number(node.property.value);
      if (!values || !Number.isInteger(index) || index < 0 || index >= values.length) return;
      replacements.push({ start: node.start, end: node.end, replacement: JSON.stringify(values[index]), array: node.object.name, index });
    },
  });
  let transformedCode = code;
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) {
    transformedCode = transformedCode.slice(0, item.start) + item.replacement + transformedCode.slice(item.end);
  }
  return { success: true, decodedCount: replacements.length, arrays: [...arrays.keys()], replacements, transformedCode };
}

function stripTerminalControl(source) {
  return source
    .replace(/\b(?:break|continue)\s*;?\s*$/g, "")
    .trim();
}

export function deflatControlFlow(code) {
  const ast = parseCode(code);
  let candidate = null;
  walk.simple(ast, {
    WhileStatement(node) {
      if (candidate) return;
      const always = node.test.type === "Literal" && node.test.value === true;
      if (!always || node.body.type !== "BlockStatement") return;
      const switchNode = node.body.body.find((statement) => statement.type === "SwitchStatement");
      if (!switchNode || switchNode.discriminant.type !== "MemberExpression") return;
      const object = switchNode.discriminant.object;
      if (object.type !== "Identifier") return;
      candidate = { whileNode: node, switchNode, orderName: object.name };
    },
  });
  if (!candidate) return { success: true, flattenedCount: 0, transformedCode: code, warning: "No supported canonical switch dispatcher found." };
  let order = null;
  walk.simple(ast, {
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name !== candidate.orderName) return;
      if (node.init?.type === "ArrayExpression") order = node.init.elements.map((item) => String(item?.value));
      const call = node.init;
      if (call?.type === "CallExpression" && call.callee.type === "MemberExpression" && call.callee.property?.name === "split" && call.callee.object.type === "Literal") {
        const separator = call.arguments[0]?.value ?? "|";
        order = String(call.callee.object.value).split(String(separator));
      }
    },
  });
  if (!order?.length) return { success: true, flattenedCount: 0, transformedCode: code, warning: "Dispatcher order could not be resolved statically." };
  const caseMap = new Map();
  for (const branch of candidate.switchNode.cases) {
    if (branch.test?.type !== "Literal") continue;
    const body = branch.consequent.map((node) => code.slice(node.start, node.end)).join("\n");
    caseMap.set(String(branch.test.value), stripTerminalControl(body));
  }
  const ordered = order.map((key) => caseMap.get(String(key))).filter(Boolean);
  if (!ordered.length) return { success: true, flattenedCount: 0, transformedCode: code, warning: "Dispatcher cases did not match the resolved order." };
  const replacement = `{\n${ordered.join("\n")}\n}`;
  const transformedCode = code.slice(0, candidate.whileNode.start) + replacement + code.slice(candidate.whileNode.end);
  return { success: true, flattenedCount: 1, order, transformedCode };
}

function constantFold(code) {
  const replacements = [];
  const ast = parseCode(code);
  walk.simple(ast, {
    BinaryExpression(node) {
      if (node.left.type !== "Literal" || node.right.type !== "Literal") return;
      const allowed = new Set(["+", "-", "*", "/", "%", "**", "<<", ">>", ">>>", "|", "&", "^", "===", "!==", "==", "!=", "<", "<=", ">", ">="]);
      if (!allowed.has(node.operator)) return;
      try {
        const value = Function(`"use strict"; return (${JSON.stringify(node.left.value)} ${node.operator} ${JSON.stringify(node.right.value)});`)();
        if (["string", "number", "boolean"].includes(typeof value) && Number.isFinite(typeof value === "number" ? value : 0)) {
          replacements.push({ start: node.start, end: node.end, replacement: JSON.stringify(value) });
        }
      } catch {}
    },
  });
  let output = code;
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) output = output.slice(0, item.start) + item.replacement + output.slice(item.end);
  return { code: output, count: replacements.length };
}

function removeDeadBranches(code) {
  const replacements = [];
  const ast = parseCode(code);
  walk.simple(ast, {
    IfStatement(node) {
      if (node.test.type !== "Literal" || typeof node.test.value !== "boolean") return;
      const chosen = node.test.value ? node.consequent : node.alternate;
      replacements.push({ start: node.start, end: node.end, replacement: chosen ? code.slice(chosen.start, chosen.end) : "" });
    },
  });
  let output = code;
  for (const item of [...replacements].sort((a, b) => b.start - a.start)) output = output.slice(0, item.start) + item.replacement + output.slice(item.end);
  return { code: output, count: replacements.length };
}

export function solveConstraints(code, { maxIterations = 100 } = {}) {
  let output = code;
  let solvedCount = 0;
  for (let index = 0; index < Math.max(1, maxIterations); index += 1) {
    const folded = constantFold(output);
    const pruned = removeDeadBranches(folded.code);
    const count = folded.count + pruned.count;
    output = pruned.code;
    solvedCount += count;
    if (count === 0) break;
  }
  return { success: true, solvedCount, transformedCode: output };
}

export function deobfuscatePipeline(code, { aggressive = false } = {}) {
  const stages = [];
  let output = code;
  const solved = solveConstraints(output);
  output = solved.transformedCode;
  stages.push({ stage: "constant-fold-and-dead-code", changes: solved.solvedCount });
  const decoded = decodeStringArrays(output);
  output = decoded.transformedCode;
  stages.push({ stage: "decode-string-arrays", changes: decoded.decodedCount });
  if (aggressive) {
    const deflat = deflatControlFlow(output);
    output = deflat.transformedCode;
    stages.push({ stage: "deflat-control-flow", changes: deflat.flattenedCount });
  }
  return { success: true, deobfuscatedCode: output, stages, originalBytes: Buffer.byteLength(code), finalBytes: Buffer.byteLength(output) };
}

function transformByName(code, transform) {
  const name = typeof transform === "string" ? transform : transform?.name;
  switch (name) {
    case "constant_fold": return { code: constantFold(code).code, name };
    case "dead_code_remove": return { code: removeDeadBranches(code).code, name };
    case "decode_string_array": return { code: decodeStringArrays(code).transformedCode, name };
    case "deflat_control_flow": return { code: deflatControlFlow(code).transformedCode, name };
    case "strip_debugger": return { code: code.replace(/\bdebugger\s*;?/g, ""), name };
    case "unescape_strings": return { code: code.replace(/['"](?:\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4})+['"]/g, (value) => {
      try { return JSON.stringify(JSON.parse(`"${value.slice(1, -1).replaceAll('"', '\\"')}"`)); } catch { return value; }
    }), name };
    default: throw new Error(`Unsupported transform: ${name || "<missing>"}`);
  }
}

function simpleDiff(before, after) {
  if (before === after) return "";
  const left = before.split("\n");
  const right = after.split("\n");
  const lines = ["--- original", "+++ transformed"];
  const total = Math.max(left.length, right.length);
  for (let index = 0; index < total; index += 1) {
    if (left[index] === right[index]) continue;
    if (left[index] !== undefined) lines.push(`-${left[index]}`);
    if (right[index] !== undefined) lines.push(`+${right[index]}`);
    if (lines.length >= 400) {
      lines.push("... diff truncated ...");
      break;
    }
  }
  return lines.join("\n");
}

export class TransformEngine {
  #chains = new Map();

  preview(code, transforms) {
    const result = this.apply(code, transforms);
    return { ...result, original: code, diff: simpleDiff(code, result.transformed) };
  }

  saveChain(name, transforms, description) {
    if (!name?.trim()) throw new Error("name is required");
    this.#chains.set(name, { name, transforms, description, createdAt: new Date().toISOString() });
    return this.#chains.get(name);
  }

  apply(code, transforms, chainName) {
    const selected = chainName ? this.#chains.get(chainName)?.transforms : transforms;
    if (!Array.isArray(selected) || selected.length === 0) throw new Error("At least one transform is required");
    let transformed = code;
    const appliedTransforms = [];
    for (const transform of selected) {
      const result = transformByName(transformed, transform);
      transformed = result.code;
      appliedTransforms.push(result.name);
    }
    return { success: true, transformed, appliedTransforms };
  }
}

const HARNESS_WORKER = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
(async () => {
  const sandbox = {
    TextEncoder, TextDecoder, URL, URLSearchParams,
    crypto: webcrypto,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    console: { log() {}, warn() {}, error() {} },
  };
  sandbox.__cabInput = workerData.input;
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  const script = new vm.Script('(async () => {\n' + workerData.code + '\nconst __cabFn = globalThis[' + JSON.stringify(workerData.functionName) + '] || (typeof ' + workerData.functionName + " === 'function' ? " + workerData.functionName + ' : undefined);\nif (typeof __cabFn !== "function") throw new Error("Requested function was not defined");\nreturn await __cabFn(globalThis.__cabInput);\n})()', { filename: 'analysis-input.js' });
  const result = await script.runInContext(context, { timeout: workerData.timeoutMs });
  parentPort.postMessage({ ok: true, output: typeof result === 'string' ? result : JSON.stringify(result) });
})().catch((error) => parentPort.postMessage({ ok: false, error: error.message }));
`;

async function runHarnessCase(code, functionName, input, timeoutMs) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const worker = new Worker(HARNESS_WORKER, {
      eval: true,
      workerData: { code, functionName, input, timeoutMs },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ input, error: `Timed out after ${timeoutMs}ms`, durationMs: Math.round(performance.now() - startedAt) });
    }, timeoutMs + 100);
    worker.once("message", (message) => {
      clearTimeout(timer);
      void worker.terminate();
      resolve({ input, ...(message.ok ? { output: message.output } : { error: message.error }), durationMs: Math.round(performance.now() - startedAt) });
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      resolve({ input, error: error.message, durationMs: Math.round(performance.now() - startedAt) });
    });
  });
}

export async function cryptoTestHarness(code, functionName, testInputs, { timeoutMs = 1_000 } = {}) {
  const results = [];
  for (const input of testInputs) results.push(await runHarnessCase(code, functionName, input, timeoutMs));
  return { success: true, allPassed: results.every((item) => !item.error), results, boundary: "Runs in a bounded worker/vm, which is defense in depth rather than a security sandbox." };
}

export async function cryptoCompare(code1, code2, functionName, testInputs, options) {
  const [left, right] = await Promise.all([
    cryptoTestHarness(code1, functionName, testInputs, options),
    cryptoTestHarness(code2, functionName, testInputs, options),
  ]);
  const comparisons = testInputs.map((input, index) => ({
    input,
    left: left.results[index],
    right: right.results[index],
    sameOutput: left.results[index]?.output === right.results[index]?.output && !left.results[index]?.error && !right.results[index]?.error,
  }));
  return { success: true, equivalent: comparisons.every((item) => item.sameOutput), comparisons };
}

export const supportedTransforms = ["constant_fold", "dead_code_remove", "decode_string_array", "deflat_control_flow", "strip_debugger", "unescape_strings"];
