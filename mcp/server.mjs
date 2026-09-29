#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer } from "./create-server.mjs";

const server = createBridgeServer();
await server.connect(new StdioServerTransport());
