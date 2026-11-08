import { beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TOOLS, type ToolGroup } from "../mcp/catalog";
import { register as coordinator } from "../mcp/tools/coordinator";
import { register as market } from "../mcp/tools/market";
import { register as monitoring } from "../mcp/tools/monitoring";
import { register as outreach } from "../mcp/tools/outreach";
import { register as prospects } from "../mcp/tools/prospects";
import { register as signals } from "../mcp/tools/signals";
import type { RegisterGroup, ToolContext, ToolRegistrar } from "../mcp/types";
import { fail, guarded } from "./errors";
import { freshDb } from "./testing";

const monidRun = vi.hoisted(() => vi.fn());
vi.mock("../monid/client", () => ({ monidDiscover: vi.fn(), monidRun }));
vi.mock("../signals", () => ({ FEEDS_BY_PLAYBOOK: {}, pollFeed: vi.fn() }));
vi.mock("../pipeline/requests", () => ({ createRequest: vi.fn(), handoff: vi.fn() }));
vi.mock("../pipeline/reports", () => ({ reportUrl: (t: string) => `https://terragent.test/r/${t}` }));
vi.mock("../email/send", () => ({ sendEmail: vi.fn(), replyInThread: vi.fn() }));
vi.mock("../email/optout", () => ({ isSuppressed: vi.fn(), optOutUrl: vi.fn() }));
vi.mock("../email/templates", () => ({ AI_DISCLOSURE: "", TemplateError: class extends Error {}, renderOutreach: vi.fn(), renderFollowup: vi.fn() }));
vi.mock("../naive/spend", () => ({ getSpendSummary: async () => { throw new Error("offline"); } }));

type Handler = (args: unknown, ctx: ToolContext) => Promise<unknown>;

function collect(group: RegisterGroup) {
  const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
  group({
    tool(name, shape, handler) {
      if (tools.has(name)) throw new Error(`duplicate ${name}`);
      tools.set(name, { shape, handler: handler as Handler });
    },
  });
  return tools;
}

/** Calls a tool the way the server will: validate with the shape, then run the handler. */
async function call(tools: Map<string, { shape: z.ZodRawShape; handler: Handler }>, name: string, args: unknown, agent: ToolContext["agent"] = "coordinator") {
  const t = tools.get(name)!;
  return t.handler(z.object(t.shape).parse(args), { agent });
}

const GROUPS: [ToolGroup, RegisterGroup][] = [
  ["signals", signals], ["prospects", prospects], ["outreach", outreach],
  ["coordinator", coordinator], ["monitoring", monitoring], ["market", market],
];

beforeAll(async () => {
  await freshDb();
});

describe("outbound MCP tool groups", () => {
  it.each(GROUPS)("%s registers exactly its catalog tools, with JSON-schema-able inputs", (group, register) => {
    const tools = collect(register);
    expect([...tools.keys()].sort()).toEqual(TOOLS.filter((t) => t.group === group).map((t) => t.name).sort());
    for (const { shape } of tools.values()) expect(() => z.toJSONSchema(z.object(shape), { io: "input" })).not.toThrow();
  });

  it("returns { error } instead of throwing", async () => {
    const tools = collect(coordinator);
    const res = await call(tools, "set_playbook_allocation", { allocations: [{ playbook: "disasters", weight: 0.5 }], reason: "r", metrics: {} });
    expect(res).toEqual({ error: "weights must sum to 1 (got 0.5000)" });
    expect(await call(collect(market), "save_market_prices", { rows: [] }).catch((e) => e)).toBeInstanceOf(z.ZodError);
  });

  it("get_allocation includes each playbook's free-sample room (per run, rounded up, and per day)", async () => {
    type Room = { playbook: string; limit_per_run: number; limit_today: number; remaining: number };
    const res = (await call(collect(coordinator), "get_allocation", {})) as { source: string; free_samples: Room[] };
    expect(res.source).toBe("default");
    expect(res.free_samples.map((s) => [s.playbook, s.limit_per_run, s.limit_today, s.remaining])).toEqual([
      ["disasters", 3, 6, 3], ["deforestation", 2, 4, 2], ["mining", 2, 3, 2], // per run of 6, per day of 12, rounded up
    ]);
  });

  it("poll_signals accepts allow_paid and only outbound playbooks", async () => {
    const tools = collect(signals);
    const shape = z.object(tools.get("poll_signals")!.shape);
    expect(shape.parse({ playbook: "mining", allow_paid: false })).toMatchObject({ allow_paid: false });
    expect(() => shape.parse({ playbook: "inbound" })).toThrow();
  });

  it("monid_run passes the calling agent and truncates huge outputs", async () => {
    monidRun.mockResolvedValue({ status: "COMPLETED", output: { rows: "x".repeat(30_000) }, cost_usd: 0.02, run_id: "run_1" });
    const res = (await call(collect(prospects), "monid_run", { provider: "akta", endpoint: "/v1/company/search", input: { body: { q: "acme" } }, purpose: "find the operator of the warehouse" }, "sourcing")) as { output: string; output_truncated: boolean };
    expect(monidRun).toHaveBeenCalledWith(expect.objectContaining({ agent: "sourcing", purpose: "find the operator of the warehouse" }));
    expect(res.output_truncated).toBe(true);
    expect(res.output.length).toBe(20_000);
  });
});

describe("guarded", () => {
  it("maps OutboundError to its message and other errors to an internal error", async () => {
    const tools = new Map<string, Handler>();
    const r = guarded({ tool: (name, _shape, handler) => void tools.set(name, handler as Handler) } satisfies ToolRegistrar);
    r.tool("a", {}, async () => fail("nope"));
    r.tool("b", {}, async () => {
      throw new Error("boom");
    });
    const ctx = { agent: "coordinator" as const };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await tools.get("a")!({}, ctx)).toEqual({ error: "nope" });
    expect(await tools.get("b")!({}, ctx)).toEqual({ error: "internal error in b: boom" });
  });
});
