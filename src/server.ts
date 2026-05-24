/**
 * Stdio entry point for the TilbudsTrolden MCP server.
 *
 * Used for `npm start` and `npm run dev` — local dev against a single
 * household identified by `TILBUDSTROLDEN_HOUSEHOLD_ID` in `.env.local`.
 * No OAuth; no per-request tenant context; the env var is the household.
 *
 * Production multi-user traffic goes through `server-http.ts` (Streamable
 * HTTP + WorkOS bearer auth + per-request `runWithHousehold`).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer, SERVER_VERSION } from "./mcp-server.js";

async function main(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`TilbudsTrolden MCP server v${SERVER_VERSION} running on stdio`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
