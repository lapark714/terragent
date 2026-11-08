import { beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/mcp/route";
import { getDb } from "../db/client";
import { createRequest } from "../pipeline/requests";
import { setupMemoryDb } from "../pipeline/testing";
import { toolsForAgent } from "./catalog";
import { clearTokenCache, collectRegistrations, issueMcpToken, runTool } from "./server";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: "ses_1" })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_1" })) }));

let plannerToken = "";

beforeAll(async () => {
  await setupMemoryDb();
  plannerToken = await issueMcpToken("planner");
});

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>, opts: { token?: string | null; accept?: string } = {}) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: opts.accept ?? "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  };
  const token = opts.token === undefined ? plannerToken : opts.token;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await POST(new Request("http://localhost/api/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) }));
  const text = await res.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, body: data ? JSON.parse(data.slice(6)) : text ? safeJson(text) : null };
}
const safeJson = (t: string) => {
  try {
    return JSON.parse(t);
  } catch {
    return t;
  }
};
const toolJson = (body: { result: { content: { text: string }[] } }) => JSON.parse(body.result.content[0].text);

describe("auth", () => {
  it("401 without a token or with an unknown one", async () => {
    expect((await rpc("tools/list", {}, { token: null })).status).toBe(401);
    expect((await rpc("tools/list", {}, { token: "tgm_not_a_real_token" })).status).toBe(401);
  });

  it("401 once a token is revoked", async () => {
    const token = await issueMcpToken("verifier");
    expect((await rpc("tools/list", {}, { token })).status).toBe(200);
    await (await getDb()).query("UPDATE mcp_tokens SET revoked = true WHERE agent = 'verifier'");
    clearTokenCache();
    expect((await rpc("tools/list", {}, { token })).status).toBe(401);
  });

  it("406 when the client doesn't accept both JSON and SSE", async () => {
    expect((await rpc("tools/list", {}, { accept: "application/json" })).status).toBe(406);
  });
});

describe("tools", () => {
  it("answers initialize as the terragent server", async () => {
    const { status, body } = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "naive", version: "1" } });
    expect(status).toBe(200);
    expect(body.result.serverInfo.name).toBe("terragent");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("tools/list shows only the caller's catalog tools, with catalog descriptions", async () => {
    const { status, body } = await rpc("tools/list", {});
    expect(status).toBe(200);
    const listed = (body.result.tools as { name: string; description: string }[]);
    const registered = new Set(collectRegistrations().map((r) => r.name));
    expect(listed.map((t) => t.name).sort()).toEqual(toolsForAgent("planner").map((t) => t.name).filter((n) => registered.has(n)).sort());
    expect(listed.find((t) => t.name === "save_data_spec")?.description).toMatch(/DataSpec/);
  });

  it("round-trips a call and logs a tool.called event", async () => {
    const req = await createRequest({ question: "Has the lake shrunk since 2020?", lat: 36, lon: -114, source: "portal" });
    const { status, body } = await rpc("tools/call", { name: "get_request", arguments: { request_id: req.id } });
    expect(status).toBe(200);
    expect(toolJson(body)).toMatchObject({ id: req.id, status: "received", question: "Has the lake shrunk since 2020?" });
    const [evt] = await (await getDb()).query<{ actor: string; payload: { tool: string; ok: boolean } }>(
      "SELECT actor, payload FROM events WHERE request_id = $1 AND type = 'tool.called'", [req.id]);
    expect(evt).toMatchObject({ actor: "planner", payload: { tool: "get_request", ok: true } });
  });

  it("handler errors come back as { error } results the model can act on", async () => {
    const { body } = await rpc("tools/call", { name: "get_request", arguments: { request_id: "req_missing" } });
    expect(body.result.isError).toBe(true);
    expect(toolJson(body)).toEqual({ error: "Unknown request req_missing." });
  });

  it("an agent can't call a tool the catalog doesn't grant it", async () => {
    const { body } = await rpc("tools/call", { name: "save_verdict", arguments: {} });
    expect(body.result?.isError ?? !!body.error).toBe(true);
    expect(JSON.stringify(body)).toMatch(/save_verdict/);
    expect(await runTool("save_verdict", {}, { agent: "planner" })).toEqual({ error: "Agent planner is not allowed to call save_verdict." });
  });

  it("validates arguments in-process the same way", async () => {
    const res = (await runTool("get_request", { request_id: 42 }, { agent: "planner" })) as { error: string };
    expect(res.error).toMatch(/^Invalid arguments for get_request/);
  });
});
