#!/usr/bin/env node
// Local entry point (stdio) — for Claude Code / Claude Desktop on your own machine.
//   YNAB_TOKEN     Personal Access Token (https://app.ynab.com/settings/developer)
//   YNAB_BUDGET_ID optional, defaults to "last-used"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildServer } from "../lib/ynab-mcp.js";

if (!process.env.YNAB_TOKEN) {
  console.error("YNAB_TOKEN is not set. Create one at https://app.ynab.com/settings/developer");
  process.exit(1);
}

const server = buildServer({ token: process.env.YNAB_TOKEN, budget: process.env.YNAB_BUDGET_ID });
await server.connect(new StdioServerTransport());
