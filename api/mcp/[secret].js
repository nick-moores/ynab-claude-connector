// Hosted entry point (Vercel function) — Streamable HTTP, stateless.
// URL: https://<deployment>/api/mcp/<MCP_SECRET>
// Env: YNAB_TOKEN, MCP_SECRET (long random string), optional YNAB_BUDGET_ID.

import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "../../lib/ynab-mcp.js";

function secretOk(given) {
  const expected = process.env.MCP_SECRET || "";
  if (expected.length < 32 || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (!secretOk(req.query.secret)) {
    res.status(404).send("Not found");
    return;
  }
  if (req.method !== "POST") {
    // Stateless server: no standalone SSE stream or session teardown.
    res.status(405).setHeader("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
    return;
  }

  const server = buildServer({ token: process.env.YNAB_TOKEN, budget: process.env.YNAB_BUDGET_ID });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
}
