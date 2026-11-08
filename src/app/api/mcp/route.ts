/** Terragent MCP gateway for the Naïve agents (Streamable HTTP, stateless). Logic: src/lib/mcp/server.ts. */
import { mcpHandler } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const maxDuration = 60;

export { mcpHandler as GET, mcpHandler as POST };
