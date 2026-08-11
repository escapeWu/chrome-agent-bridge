#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeOfflineError, callBridge } from "../lib/bridge-client.mjs";

const server = new McpServer({
  name: "chrome-agent-bridge",
  version: "0.6.0",
});

function asText(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function asError(error) {
  const code = error?.code || (error instanceof BridgeOfflineError ? "bridge_offline" : "bridge_error");
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: {
            code,
            message: error instanceof Error ? error.message : String(error),
            recovery:
              code === "bridge_offline"
                ? "Ensure the unpacked extension and native host are installed, reload the extension, then retry."
                : code === "unauthorized"
                  ? "Reload the local token or renew it from the extension popup, then retry."
                  : "Inspect current browser state before retrying.",
          },
        }, null, 2),
      },
    ],
  };
}

function tool(name, config, handler) {
  server.registerTool(name, config, async (input) => {
    try {
      return await handler(input);
    } catch (error) {
      return asError(error);
    }
  });
}

tool(
  "browser_status",
  {
    title: "Browser status",
    description: "Check whether the Chrome extension and native host are connected.",
    inputSchema: {},
  },
  async () => asText(await callBridge("browser.status")),
);

tool(
  "browser_list_tabs",
  {
    title: "List Chrome tabs",
    description: "List current scriptable Chrome tabs. Use before selecting a tab ID.",
    inputSchema: {},
  },
  async () => asText({ tabs: await callBridge("tabs.list") }),
);

tool(
  "browser_open_tab",
  {
    title: "Open Chrome tab",
    description: "Open an HTTP, HTTPS, file, or about:blank URL in Chrome.",
    inputSchema: {
      url: z.string().url().or(z.literal("about:blank")),
      active: z.boolean().optional().default(true),
    },
  },
  async (input) => asText(await callBridge("tabs.create", input)),
);

tool(
  "browser_activate_tab",
  {
    title: "Activate Chrome tab",
    description: "Activate a Chrome tab and focus its window.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => asText(await callBridge("tabs.activate", input)),
);

tool(
  "browser_close_tab",
  {
    title: "Close bridge-created Chrome tab",
    description: "Close a tab only when it was created by Chrome Agent Bridge in the current extension session.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => asText(await callBridge("tabs.close", input)),
);

tool(
  "browser_navigate",
  {
    title: "Navigate Chrome tab",
    description: "Navigate an existing tab to an HTTP, HTTPS, file, or about:blank URL.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      url: z.string().url().or(z.literal("about:blank")),
    },
  },
  async (input) => asText(await callBridge("tabs.navigate", input)),
);

tool(
  "browser_snapshot",
  {
    title: "Snapshot page",
    description: "Read visible page text and interactive elements with CSS selectors.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      maxChars: z.number().int().min(1_000).max(50_000).optional().default(30_000),
    },
  },
  async (input) => asText(await callBridge("page.snapshot", input)),
);

tool(
  "browser_screenshot",
  {
    title: "Screenshot page",
    description: "Capture the visible viewport of a Chrome tab. This activates the tab.",
    inputSchema: { tabId: z.number().int().nonnegative() },
  },
  async (input) => {
    const result = await callBridge("page.screenshot", input);
    const match = /^data:image\/png;base64,(.+)$/.exec(result.dataUrl || "");
    if (!match) throw new Error("Extension returned an invalid PNG screenshot");
    return {
      content: [
        { type: "text", text: `Captured Chrome tab ${result.tabId}.` },
        { type: "image", data: match[1], mimeType: "image/png" },
      ],
    };
  },
);

tool(
  "browser_click",
  {
    title: "Click page element",
    description: "Click one visible, enabled element using a selector from a recent snapshot.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2_000),
      confirmed: z
        .boolean()
        .optional()
        .default(false)
        .describe("Set true only after the user explicitly confirms a potentially submitting click."),
    },
  },
  async (input) => asText(await callBridge("page.click", input)),
);

tool(
  "browser_fill",
  {
    title: "Fill page field",
    description: "Fill one visible non-password text field. This tool never submits the form.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      selector: z.string().min(1).max(2_000),
      value: z.string().max(100_000),
    },
  },
  async (input) => asText(await callBridge("page.fill", input)),
);

tool(
  "browser_watch_events",
  {
    title: "Watch Chrome tab events",
    description: "Long-poll tab created, updated, removed, and activated events after a cursor.",
    inputSchema: {
      afterSequence: z.number().int().nonnegative().optional().default(0),
      tabId: z.number().int().nonnegative().optional().describe("Return only events for this tab."),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(await callBridge("events.poll", input, { timeoutMs: input.timeoutMs + 5_000 })),
);

const networkSessionId = z.string().min(20).max(120);
const rawSessionId = z.string().min(20).max(120);
const networkResourceType = z.enum([
  "document",
  "stylesheet",
  "image",
  "media",
  "font",
  "script",
  "xhr",
  "fetch",
  "websocket",
  "other",
]);

tool(
  "browser_network_start",
  {
    title: "Start network monitoring",
    description:
      "Start a tab-scoped, metadata-only Chrome network monitor. Pass rawSessionId to reuse that Raw CDP attachment instead of attaching a second debugger. Headers and bodies are never returned.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      rawSessionId: rawSessionId.optional(),
      urlMode: z.enum(["origin_path", "full"]).optional().default("origin_path"),
      resourceTypes: z.array(networkResourceType).max(10).optional().default([]),
      urlIncludes: z.array(z.string().max(200)).max(20).optional().default([]),
      maxEvents: z.number().int().min(1).max(1_000).optional().default(500),
      maxBytes: z.number().int().min(65_536).max(4_000_000).optional().default(1_000_000),
    },
  },
  async (input) => asText(await callBridge("network.start", input)),
);

tool(
  "browser_network_poll",
  {
    title: "Poll network events",
    description:
      "Read sanitized request, response, completion, failure, and WebSocket lifecycle metadata after a cursor. Completion and failure events include method, status when known, and durationMs.",
    inputSchema: {
      sessionId: networkSessionId,
      afterCursor: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(200).optional().default(100),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(
    await callBridge("network.poll", input, { timeoutMs: input.timeoutMs + 5_000 }),
  ),
);

tool(
  "browser_network_stop",
  {
    title: "Stop network monitoring",
    description: "Stop a network monitor and release its resources. It detaches Chrome only when the monitor owns the attachment; a reused Raw session remains attached.",
    inputSchema: { sessionId: networkSessionId },
  },
  async (input) => asText(await callBridge("network.stop", input)),
);

tool(
  "browser_cdp_attach",
  {
    title: "Attach Raw CDP",
    description:
      "Attach an unrestricted Chrome DevTools Protocol session to one tab. Set captureEvents=false when only commands plus a sanitized network projection are needed; captured Raw events may expose credentials and private data.",
    inputSchema: {
      tabId: z.number().int().nonnegative(),
      captureEvents: z.boolean().optional().default(true),
      maxEvents: z.number().int().min(1).max(1_000).optional().default(500),
      maxBytes: z.number().int().min(65_536).max(3_000_000).optional().default(1_000_000),
    },
  },
  async (input) => asText(await callBridge("raw.attach", input)),
);

tool(
  "browser_cdp_send",
  {
    title: "Send Raw CDP command",
    description:
      "Send any CDP method and JSON params without a method allowlist or response sanitization. Use targetSessionId for a child target previously attached within this Raw CDP session.",
    inputSchema: {
      sessionId: rawSessionId,
      method: z.string().min(1).max(200),
      params: z.record(z.unknown()).optional().default({}),
      targetSessionId: z.string().min(1).max(200).optional(),
    },
  },
  async (input) => asText(await callBridge("raw.send", input)),
);

tool(
  "browser_cdp_events",
  {
    title: "Poll Raw CDP events",
    description:
      "Read original CDP event methods, source targets, and params without field sanitization. Results may contain secrets or private browsing data.",
    inputSchema: {
      sessionId: rawSessionId,
      afterCursor: z.number().int().nonnegative().optional().default(0),
      limit: z.number().int().min(1).max(200).optional().default(100),
      timeoutMs: z.number().int().min(0).max(25_000).optional().default(10_000),
    },
  },
  async (input) => asText(
    await callBridge("raw.poll", input, { timeoutMs: input.timeoutMs + 5_000 }),
  ),
);

tool(
  "browser_cdp_detach",
  {
    title: "Detach Raw CDP",
    description: "Detach an unrestricted CDP session from its tab and release child-target routing state.",
    inputSchema: { sessionId: rawSessionId },
  },
  async (input) => asText(await callBridge("raw.detach", input)),
);

await server.connect(new StdioServerTransport());
