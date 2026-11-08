/**
 * Terragent MCP gateway (ARCHITECTURE §1, §7). One bearer token per agent → sha256 → mcp_tokens → AgentName.
 *
 * tools/list is per agent: each agent gets its own McpServer with only the catalog tools granted to it
 * (mcp-handler builds a fresh server per request, so we keep one handler per agent). A call to a tool
 * outside that set fails in the SDK as "Tool … not found"; runTool() re-checks the allowlist anyway, so the
 * same rules hold for in-process callers (simulator, tests).
 */
import { redactSecrets } from "../redact";
import { createHash, randomBytes } from "node:crypto";
import type { AuthInfo, CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { getDb } from "../db/client";
import { AgentName } from "../domain";
import { logEvent } from "../events";
import { canCall, TERRAGENT_MCP_SERVER, toolSpec, toolsForAgent } from "./catalog";
import { TOOL_GROUPS } from "./tools";
import type { RegisterGroup, ToolContext, ToolHandler } from "./types";

export interface Registration {
  name: string;
  group: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: ToolHandler<z.ZodRawShape>;
}

/** Run every group against a recording registrar. Duplicates are kept so the coverage test can report them. */
export function collectRegistrations(groups: Record<string, RegisterGroup> = TOOL_GROUPS): Registration[] {
  const out: Registration[] = [];
  for (const [group, register] of Object.entries(groups)) {
    register({
      tool(name, shape, handler) {
        out.push({ name, group, schema: z.object(shape), handler: handler as unknown as ToolHandler<z.ZodRawShape> });
      },
    });
  }
  return out;
}

let registry: Map<string, Registration> | null = null;

function tools(): Map<string, Registration> {
  if (registry) return registry;
  registry = new Map();
  for (const r of collectRegistrations()) {
    if (!toolSpec(r.name)) console.error(`[mcp] ${r.group} registered ${r.name}, which is not in the catalog; ignored.`);
    else if (registry.has(r.name)) console.error(`[mcp] ${r.name} registered twice (${registry.get(r.name)!.group}, ${r.group}); kept the first.`);
    else registry.set(r.name, r);
  }
  return registry;
}

const isErrorResult = (v: unknown) => typeof v === "object" && v !== null && "error" in v;

/** Allowlist, validation, error wrapping and the tool.called event, shared by MCP and in-process callers. */
export async function runTool(name: string, args: unknown, ctx: ToolContext): Promise<unknown> {
  const started = Date.now();
  const reg = tools().get(name);
  let result: unknown;
  if (!reg) result = { error: `Unknown tool ${name}.` };
  else if (!canCall(ctx.agent, name)) result = { error: `Agent ${ctx.agent} is not allowed to call ${name}.` };
  else {
    const parsed = reg.schema.safeParse(args ?? {});
    if (!parsed.success) result = { error: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` };
    else {
      try {
        result = (await reg.handler(parsed.data, ctx)) ?? { ok: true };
      } catch (e) {
        // Agents read this text: never let a connection string or key leak through an exception message.
        result = { error: redactSecrets(e instanceof Error ? e.message : String(e)) };
      }
    }
  }
  await logToolCall(name, args, ctx, result, Date.now() - started);
  return result;
}

async function logToolCall(tool: string, args: unknown, ctx: ToolContext, result: unknown, ms: number) {
  const requestId = (args as { request_id?: unknown } | null)?.request_id;
  const error = isErrorResult(result) ? String((result as { error: unknown }).error).slice(0, 300) : undefined;
  try {
    await logEvent("tool.called", ctx.agent, { tool, ok: !error, ms, ...(error ? { error } : {}), ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}) },
      typeof requestId === "string" ? requestId : null);
  } catch (e) {
    console.error("[mcp] tool.called event failed:", e);
  }
}

export function toCallToolResult(result: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(result) }], ...(isErrorResult(result) ? { isError: true } : {}) };
}

/** Register the agent's catalog tools on one McpServer. */
export function initServerFor(agent: AgentName) {
  return (server: McpServer) => {
    for (const spec of toolsForAgent(agent)) {
      const reg = tools().get(spec.name);
      if (!reg) continue; // not implemented yet (the coverage test lists these)
      server.registerTool(spec.name, { description: spec.description, inputSchema: reg.schema }, async (args, ctx) => {
        const sessionId = ctx.http?.req?.headers.get("x-terragent-session") ?? undefined;
        return toCallToolResult(await runTool(spec.name, args, { agent, sessionId }));
      });
    }
  };
}

const handlers = new Map<AgentName, (req: Request) => Promise<Response>>();

function handlerFor(agent: AgentName) {
  let h = handlers.get(agent);
  if (!h) {
    h = createMcpHandler(initServerFor(agent), { serverInfo: { name: TERRAGENT_MCP_SERVER, version: "1.0.0" } });
    handlers.set(agent, h);
  }
  return h;
}

export const hashMcpToken = (raw: string) => createHash("sha256").update(raw).digest("hex");

const TOKEN_TTL_MS = 60_000;
const tokenCache = new Map<string, { agent: AgentName | null; at: number }>();

/** Bearer → agent. Cached for a minute, so revoking a token takes effect within 60 s. */
export async function agentForToken(raw: string): Promise<AgentName | null> {
  const hash = hashMcpToken(raw);
  const hit = tokenCache.get(hash);
  if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.agent;
  const db = await getDb();
  const [row] = await db.query<{ agent: string }>("SELECT agent FROM mcp_tokens WHERE token_hash = $1 AND NOT revoked", [hash]);
  const agent = AgentName.safeParse(row?.agent).data ?? null;
  tokenCache.set(hash, { agent, at: Date.now() });
  return agent;
}

export function clearTokenCache() {
  tokenCache.clear();
}

/** Mint a bearer token for an agent (provisioning). Only the hash is stored; vault the raw value in Naïve. */
export async function issueMcpToken(agent: AgentName): Promise<string> {
  const raw = `tgm_${randomBytes(32).toString("base64url")}`;
  const db = await getDb();
  await db.query("INSERT INTO mcp_tokens (token_hash, agent) VALUES ($1, $2)", [hashMcpToken(raw), agent]);
  return raw;
}

export async function verifyToken(_req: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const agent = await agentForToken(bearer);
  return agent ? { token: bearer, clientId: agent, scopes: [], extra: { agent } } : undefined;
}

/** The /api/mcp route handler: 401 without a valid agent token, then that agent's server. */
export const mcpHandler = withMcpAuth(
  (req) => handlerFor(req.auth!.clientId as AgentName)(req),
  verifyToken,
  { required: true },
);
