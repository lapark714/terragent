/** Terragent MCP gateway for the Naïve agents (Streamable HTTP, stateless). Logic: src/lib/mcp/server.ts. */
import { mcpHandler } from "@/lib/mcp/server";

export const runtime = "nodejs";
/**
 * Some tools legitimately run for minutes: poll_signals walks 8 GFW regions two at a time (45 s timeout each), and
 * monid_run waits up to 90 s for a run plus 90 s of polling. A function killed mid-call leaves the agent with a transport
 * error and can hide Monid spend, so allow Vercel's Fluid-compute ceiling (300 s, docs/platform/web-and-providers.md).
 */
export const maxDuration = 300;

export { mcpHandler as GET, mcpHandler as POST };
