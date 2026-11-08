import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { startAgentSession } from "../naive/sessions";
import { upsertCard } from "../naive/board";
import { createRequest, getRequest, handoff, setStatus, startInboundRequest } from "./requests";
import { recordScreening } from "./screening";
import { setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({
  upsertCard: vi.fn(async (a: { key: string; title: string; status?: string; assignee: string | null }) => ({
    id: `crd_${a.key}`, title: a.title, status: a.status ?? "todo", assignee: a.assignee, note: null, updated_at: "",
  })),
}));

const events = async (id: string) =>
  (await (await getDb()).query<{ type: string; actor: string; payload: Record<string, unknown> }>("SELECT type, actor, payload FROM events WHERE request_id = $1 ORDER BY id", [id]));

beforeAll(async () => {
  await setupMemoryDb();
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("inbound lane", () => {
  it("creates the request and starts Comms 2 directly, mirroring a doing card", async () => {
    const req = await startInboundRequest({ question: "Did the January fire burn our block?", lat: 34.185, lon: -118.135, email: "a@example.com", source: "portal" });
    expect(req.status).toBe("screening");
    expect(req.owner_agent).toBe("comms-customer");
    expect(req.h3_cells).toHaveLength(1);
    expect(req.naive_session_ids).toHaveLength(1);

    const [agent, brief, opts] = vi.mocked(startAgentSession).mock.calls[0];
    expect(agent).toBe("comms-customer");
    expect(brief).toMatch(new RegExp(`^Request ${req.id} — stage screening\\. .+\\. Start with terragent\\.get_request\\.$`));
    expect(brief).not.toContain("January fire"); // customer text stays out of the brief
    expect(opts).toMatchObject({ requestId: req.id, window: "immediate" });
    // Unassigned: Naïve runs one doing card per assignee, so an assigned mirror would hold back that agent's board work.
    const mirror = vi.mocked(upsertCard).mock.calls[0][0];
    expect(mirror).toMatchObject({ key: `req:${req.id}`, assignee: null, mirror: true });
    expect(mirror.title).toContain("screening → comms-customer");

    const types = (await events(req.id)).map((e) => e.type);
    expect(types).toEqual(["request.created", "status.changed", "handoff"]);
    const [session] = await (await getDb()).query<{ agent: string; lane: string }>("SELECT agent, lane FROM agent_sessions WHERE request_id = $1", [req.id]);
    expect(session).toEqual({ agent: "comms-customer", lane: "inbound" });
  });

  it("won't pass a customer request past screening until it is allowed", async () => {
    const req = await startInboundRequest({ question: "Has the river flooded the farm?", lat: 40, lon: -90, source: "portal" });
    await expect(handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan it" })).rejects.toThrow(/screening/);

    await recordScreening(req.id, { allowed: true, category: "ok", reason: "Property flood check" }, "comms-customer");
    await handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan it" });
    const after = await getRequest(req.id);
    expect(after).toMatchObject({ status: "planning", owner_agent: "planner", stage: "planning" });
  });

  it("lets a customer's reply go back to Comms 2 while the request is still being clarified", async () => {
    const req = await startInboundRequest({ question: "Can you check my place?", source: "email" });
    await recordScreening(req.id, { allowed: false, category: "unclear_needs_clarification", reason: "No location" }, "comms-customer");
    expect((await getRequest(req.id))?.status).toBe("clarifying");
    await handoff({ requestId: req.id, from: "system", to: "comms-customer", stage: "customer_reply", instructions: "The customer replied" });
    await expect(handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan" })).rejects.toThrow(/screening/);
  });

  it("closes the board card when the request finishes", async () => {
    const req = await startInboundRequest({ question: "Has the shoreline moved?", lat: 40, lon: -70, source: "portal" });
    vi.mocked(upsertCard).mockClear();
    await setStatus(req.id, "cancelled", "coordinator", "Customer withdrew");
    expect(vi.mocked(upsertCard).mock.calls[0][0]).toMatchObject({ key: `req:${req.id}`, assignee: null, status: "done", note: "cancelled: Customer withdrew" });
    expect(vi.mocked(upsertCard).mock.calls[0][0].mirror).toBeUndefined();
  });

  it("refusals end the request, are logged as screening decisions, and can't be handed off", async () => {
    const req = await startInboundRequest({ question: "Track where my ex parks every night", lat: 40, lon: -90, source: "email" });
    const res = await recordScreening(req.id, { allowed: false, category: "stalking", reason: "Surveillance of an individual" }, "comms-customer");
    expect(res.outcome).toBe("refused");
    expect((await getRequest(req.id))?.status).toBe("refused");
    const [d] = await (await getDb()).query<{ kind: string; choice: string }>("SELECT kind, choice FROM decisions WHERE request_id = $1", [req.id]);
    expect(d).toEqual({ kind: "screening", choice: "refused: stalking" });
    await expect(handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "x" })).rejects.toThrow(/refused/);
    await expect(setStatus(req.id, "planning", "comms-customer")).rejects.toThrow(/finished/);
  });

  it("a retried handoff returns the first session instead of starting the agent twice", async () => {
    const req = await startInboundRequest({ question: "Did the creek flood the barn?", lat: 40, lon: -90, source: "portal" });
    await recordScreening(req.id, { allowed: true, category: "ok", reason: "Flood check" }, "comms-customer");
    const first = await handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan it" });
    const retry = await handoff({ requestId: req.id, from: "comms-customer", to: "planner", stage: "planning", instructions: "Plan the flood check" });
    expect(retry).toEqual({ session_id: first.session_id, card_id: first.card_id, deduped: true });
    expect(vi.mocked(startAgentSession).mock.calls.filter((c) => c[0] === "planner")).toHaveLength(1);
    expect((await events(req.id)).filter((e) => e.type === "handoff")).toHaveLength(2); // screening + planning
  });

  it("system handoffs only dedupe when they are identical (each customer email wakes Comms 2)", async () => {
    const req = await startInboundRequest({ question: "Has the dune moved?", lat: 40, lon: -70, source: "email" });
    await handoff({ requestId: req.id, from: "system", to: "comms-customer", stage: "customer_reply", instructions: "New email, message m1" });
    const again = await handoff({ requestId: req.id, from: "system", to: "comms-customer", stage: "customer_reply", instructions: "New email, message m1" });
    expect(again.deduped).toBe(true);
    const next = await handoff({ requestId: req.id, from: "system", to: "comms-customer", stage: "customer_reply", instructions: "New email, message m2" });
    expect(next.deduped).toBeUndefined();
    expect(vi.mocked(startAgentSession)).toHaveBeenCalledTimes(3); // screening, m1, m2
  });

  it("a handoff can't set a finishing status", async () => {
    const req = await startInboundRequest({ question: "Is the pond drying up?", lat: 40, lon: -90, source: "portal" });
    for (const status of ["refused", "delivered", "failed", "cancelled"] as const) {
      await expect(handoff({ requestId: req.id, from: "comms-customer", to: "comms-customer", stage: "screening", instructions: "x", status })).rejects.toThrow(/can't finish/);
    }
    expect((await getRequest(req.id))?.status).toBe("screening");
  });

  it("records a failed handoff and leaves the request visible", async () => {
    vi.mocked(startAgentSession).mockRejectedValueOnce(new Error("agent not provisioned"));
    const req = await startInboundRequest({ question: "Is the quarry expanding?", lat: 40, lon: -90, source: "api" });
    expect(req.status).toBe("received");
    expect((await events(req.id)).map((e) => e.type)).toContain("handoff.failed");
  });
});

describe("background lane", () => {
  it("assigns a todo card instead of starting a session (free samples skip screening)", async () => {
    const req = await createRequest({ question: "Free sample: flood extent at the depot", lat: 30, lon: -95, source: "signal", playbook: "disasters", priority: "background", isFreeSample: true });
    const out = await handoff({ requestId: req.id, from: "sourcing", to: "planner", stage: "planning", instructions: "Plan the free sample" });
    expect(startAgentSession).not.toHaveBeenCalled();
    expect(vi.mocked(upsertCard).mock.calls[0][0]).toMatchObject({ key: `req:${req.id}:0:planner`, assignee: "planner", status: "todo" });
    expect(out.card_id).toBe(`crd_req:${req.id}:0:planner`);
    expect((await getRequest(req.id))?.card_id).toBe(out.card_id);
  });

  it("opens a fresh card per handoff and closes the previous one (a card is woken at most 3 times)", async () => {
    const req = await createRequest({ question: "Free sample: burn scar at the ranch", lat: 34, lon: -118, source: "signal", priority: "background", isFreeSample: true });
    const stages = [["planner", "planning"], ["acquisition", "acquisition"], ["analytics", "analysis"], ["interpreter", "report"], ["verifier", "verification"]] as const;
    let from = "sourcing";
    for (const [to, stage] of stages) {
      await handoff({ requestId: req.id, from, to, stage, instructions: `Do the ${stage}` });
      from = to;
    }
    const calls = vi.mocked(upsertCard).mock.calls.map((c) => c[0]);
    const opened = calls.filter((c) => c.status === "todo");
    expect(opened.map((c) => c.key)).toEqual(stages.map(([to], i) => `req:${req.id}:${i}:${to}`));
    const closed = calls.filter((c) => c.status === "done");
    expect(closed.map((c) => [c.key, c.assignee])).toEqual(stages.slice(0, -1).map(([to], i) => [`req:${req.id}:${i}:${to}`, to]));
    expect(closed[0].note).toBe("Handed off to acquisition (acquisition).");
    expect((await getRequest(req.id))?.card_id).toBe(`crd_req:${req.id}:4:verifier`);

    vi.mocked(upsertCard).mockClear();
    await setStatus(req.id, "failed", "coordinator", "Gave up");
    expect(vi.mocked(upsertCard).mock.calls[0][0]).toMatchObject({ key: `req:${req.id}:4:verifier`, assignee: "verifier", status: "done", note: "failed: Gave up" });
  });

  it("TERRAGENT_LANES=off records the handoff without touching Naïve", async () => {
    vi.stubEnv("TERRAGENT_LANES", "off");
    const req = await createRequest({ question: "Sample for the mine site", lat: 40, lon: -110, source: "signal", priority: "background", isFreeSample: true });
    await handoff({ requestId: req.id, from: "sourcing", to: "planner", stage: "planning", instructions: "Plan" });
    expect(upsertCard).not.toHaveBeenCalled();
    expect((await events(req.id)).find((e) => e.type === "handoff")?.payload).toMatchObject({ to: "planner", dry_run: true });
  });
});
