/**
 * Registration interface between the MCP server (core builder, src/lib/mcp/server.ts) and the tool groups
 * (src/lib/mcp/tools/<group>.ts, core + outbound builders). Groups depend only on this file.
 */
import type { z } from "zod";
import type { AgentName } from "../domain";

export interface ToolContext {
  /** Calling agent, resolved from its bearer token. */
  agent: AgentName;
  /** Naïve session id if the client sent one (x-terragent-session header), for cost attribution. */
  sessionId?: string;
}

export type ToolHandler<S extends z.ZodRawShape> = (
  args: z.infer<z.ZodObject<S>>,
  ctx: ToolContext,
) => Promise<unknown>;

export interface ToolRegistrar {
  /**
   * Register one catalog tool. `name` must exist in src/lib/mcp/catalog.ts; the server takes the
   * description from the catalog and enforces the catalog's agent allowlist before calling `handler`.
   * Return any JSON-serialisable value; return `{ error: "…" }` for failures the model should act on.
   */
  tool<S extends z.ZodRawShape>(name: string, shape: S, handler: ToolHandler<S>): void;
}

export type RegisterGroup = (r: ToolRegistrar) => void;
