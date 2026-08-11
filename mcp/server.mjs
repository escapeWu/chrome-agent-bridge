#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeOfflineError, callBridge } from "../lib/bridge-client.mjs";

const server = new McpServer({
  name: "chrome-agent-bridge",
  version: "0.3.0",
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

await server.connect(new StdioServerTransport());
