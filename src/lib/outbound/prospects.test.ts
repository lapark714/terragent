import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import type { ProspectInput } from "../domain";
import { sampleCap, setPlaybookAllocation, withOneStarted } from "./allocation";
import { createProspect, listProspects, requestFreeSample, sampleQuestion } from "./prospects";
import { freshDb, insert, reset, seedProspect, seedSignal } from "./testing";

const mocks = vi.hoisted(() => ({ createRequest: vi.fn(), handoff: vi.fn(), isSuppressed: vi.fn() }));
vi.mock("../pipeline/requests", () => ({ createRequest: mocks.createRequest, handoff: mocks.handoff }));
vi.mock("../email/optout", () => ({ isSuppressed: mocks.isSuppressed }));

let db: Db;
let counter = 0;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
  vi.clearAllMocks();
  mocks.isSuppressed.mockResolvedValue(false);
  // Like core's handoff: the request gets an owner and a stage.
  mocks.handoff.mockImplementation(async (h: { requestId: string; to: string; stage: string }) => {
    await db.query("UPDATE requests SET owner_agent = $2, stage = $3 WHERE id = $1", [h.requestId, h.to, h.stage]);
    return { card_id: "crd_1" };
  });
  // Behaves like core's createRequest closely enough for cap counting.
  mocks.createRequest.mockImplementation(async (input: { source: string; playbook: string; question: string; isFreeSample: boolean; prospectId: string }) => {
    const id = `req_m${++counter}`;
    await insert(db, "requests", { id, source: input.source, playbook: input.playbook, question: input.question, is_free_sample: input.isFreeSample, prospect_id: input.prospectId, priority: "background" });
    return { id };
  });
});
afterEach(() => {
  vi.useRealTimers();
});

const input = (signalId: string, over: Partial<ProspectInput> = {}): ProspectInput => ({
  signal_id: signalId, playbook: "disasters", company: "Desert Logistics", domain: "https://www.DesertLogistics.com/about",
  contact_name: "Sam Ortiz", contact_email: "sam@desertlogistics.com", contact_role: "Facilities manager",
  asset_description: "Distribution centre, 400 S 35th Ave, Phoenix", asset_lat: 33.444, asset_lon: -112.13,
  score_fit: 0.9, score_urgency: 0.8, score_ability: 0.5, score_reach: 0.5, rationale: "inside the flood polygon", ...over,
});

describe("createProspect", () => {
  it("scores fit × urgency × ability × reach, normalises the domain and marks the signal matched", async () => {
    const sig = await seedSignal(db);
    const res = await createProspect({ input: input(sig), contactFormUrl: "https://desertlogistics.com/contact", actor: "sourcing" });
    expect(res).toMatchObject({ duplicate: false, status: "matched", score_total: 0.18, planned_channel: "contact_form", warnings: [] });
    const [row] = await db.query<{ domain: string; score_total: string; contact_form_url: string }>("SELECT domain, score_total, contact_form_url FROM prospects");
    expect(row).toEqual({ domain: "desertlogistics.com", score_total: "0.1800", contact_form_url: "https://desertlogistics.com/contact" });
    const [s] = await db.query<{ status: string }>("SELECT status FROM signals WHERE id = $1", [sig]);
    expect(s.status).toBe("matched");
  });

  it("drops personal mailboxes (work contacts only) and plans the contact form", async () => {
    const sig = await seedSignal(db);
    const res = await createProspect({ input: input(sig, { contact_email: "sam.ortiz@gmail.com", domain: null }), actor: "sourcing" });
    expect(res.planned_channel).toBe("contact_form");
    expect(res.warnings?.[0]).toMatch(/personal mailbox gmail\.com/);
    const [row] = await db.query<{ contact_email: string | null; warm: boolean; meta: Record<string, unknown> }>("SELECT contact_email, warm, meta FROM prospects");
    expect(row.contact_email).toBeNull();
    expect(row.warm).toBe(false);
    expect(row.meta.personal_mailbox_dropped).toBe(true);
  });

  it("never dedupes on a shared host: two businesses with Facebook pages are two prospects", async () => {
    const sig = await seedSignal(db);
    const fb = (company: string, page: string) => input(sig, { company, domain: `https://www.facebook.com/${page}`, contact_email: null });
    const a = await createProspect({ input: fb("Acme Roofing", "acmeroofing"), actor: "sourcing" });
    const b = await createProspect({ input: fb("Best Gutters", "bestgutters"), actor: "sourcing" });
    expect([a.duplicate, b.duplicate]).toEqual([false, false]);
    const rows = await db.query<{ domain: string | null; meta: { website?: string } }>("SELECT domain, meta FROM prospects ORDER BY company");
    expect(rows.map((r) => [r.domain, r.meta.website])).toEqual([[null, "https://www.facebook.com/acmeroofing"], [null, "https://www.facebook.com/bestgutters"]]);
    expect((await createProspect({ input: fb("acme roofing", "acme-roofing-az"), actor: "sourcing" })).duplicate).toBe(true);
  });

  it("returns the existing prospect for the same business in a playbook", async () => {
    const sig = await seedSignal(db);
    const first = await createProspect({ input: input(sig), actor: "sourcing" });
    const again = await createProspect({ input: input(sig, { company: "desert logistics", domain: null, contact_email: null }), actor: "sourcing" });
    expect(again).toMatchObject({ id: first.id, duplicate: true });
  });

  it("stores opted-out contacts as opted_out, and rejects unknown signals and the inbound playbook", async () => {
    const sig = await seedSignal(db);
    mocks.isSuppressed.mockResolvedValue(true);
    expect((await createProspect({ input: input(sig), actor: "sourcing" })).status).toBe("opted_out");
    await expect(createProspect({ input: input("sig_nope", { company: "Other" }), actor: "sourcing" })).rejects.toThrow(/not found/);
    await expect(createProspect({ input: input(sig, { playbook: "inbound", company: "X" }), actor: "sourcing" })).rejects.toThrow(/outbound playbook/);
    await expect(createProspect({ input: { ...input(sig), score_fit: 2 }, actor: "sourcing" })).rejects.toThrow(/score_fit/);
  });

  it("lists by score, without exposing contact emails", async () => {
    await seedProspect(db, { score_total: 0.2, company: "Low" });
    await seedProspect(db, { score_total: 0.7, company: "High" });
    const list = await listProspects({ playbook: "disasters" });
    expect(list.map((p) => p.company)).toEqual(["High", "Low"]);
    expect(list[0]).not.toHaveProperty("contact_email");
    expect(list[0].has_email).toBe(true);
    expect(await listProspects({ minScore: 0.5 })).toHaveLength(1);
  });
});

describe("requestFreeSample", () => {
  it("creates a background free-sample request from the asset and hands it to the planner", async () => {
    const sig = await seedSignal(db, { title: "Flood Warning for Maricopa, AZ", event_time: "2026-11-07T10:00:00Z" });
    const pro = await seedProspect(db, { signal_id: sig, company: "Desert Logistics" });
    const res = await requestFreeSample({ prospectId: pro, actor: "sourcing" });
    expect(res).toMatchObject({
      already_requested: false,
      cap: { playbook: "disasters", weight: 0.5, limit_per_run: 3, started_this_run: 1, limit_today: 6, started_today: 1, limit_today_total: 12, remaining: 2 },
    });

    const arg = mocks.createRequest.mock.calls[0][0];
    expect(arg).toMatchObject({ source: "signal", playbook: "disasters", priority: "background", isFreeSample: true, prospectId: pro, lat: 33.45, lon: -111.94 });
    expect(arg.question).toContain('after "Flood Warning for Maricopa, AZ" (2026-11-07)');
    expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({ requestId: res.request_id, to: "planner", stage: "planning", from: "sourcing" }));
    const [p] = await db.query<{ status: string; sample_request_id: string }>("SELECT status, sample_request_id FROM prospects WHERE id = $1", [pro]);
    expect(p).toEqual({ status: "sample_requested", sample_request_id: res.request_id });

    expect(await requestFreeSample({ prospectId: pro, actor: "sourcing" })).toEqual({ request_id: res.request_id, already_requested: true });
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("caps samples per run by allocation weight, rounded up", async () => {
    await setPlaybookAllocation({ input: { allocations: [{ playbook: "disasters", weight: 0.3 }, { playbook: "deforestation", weight: 0.7 }], reason: "test", metrics: {} }, measured: {}, actor: "coordinator" });
    // disasters: ceil(6 × 0.3) = 2 per run; mining at weight 0 gets none.
    for (let i = 0; i < 2; i++) await requestFreeSample({ prospectId: await seedProspect(db), actor: "sourcing" });
    await expect(requestFreeSample({ prospectId: await seedProspect(db), actor: "sourcing" })).rejects.toThrow(/cap reached for disasters: 2\/2 this run/);
    await expect(requestFreeSample({ prospectId: await seedProspect(db, { playbook: "mining" }), actor: "sourcing" })).rejects.toThrow(/mining: its weight is 0/);
  });

  const startedAt = (iso: string, n: number, playbook = "disasters") =>
    db.query(
      `INSERT INTO requests (id, source, playbook, question, is_free_sample, priority, created_at)
       SELECT 'req_at' || md5($1 || $3 || g), 'signal', $3, 'q', true, 'background', $1::timestamptz FROM generate_series(1, $2) g`,
      [iso, n, playbook],
    );

  it("counts a run as the last hour, and also caps the day (CAPS.freeSamplesPerDay × weight)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    await startedAt("2029-12-31T23:30:00Z", 30); // yesterday: counts for nothing
    await startedAt("2030-01-01T09:00:00Z", 3); // today, an earlier run
    await startedAt("2030-01-01T11:30:00Z", 2); // this run
    // disasters at the default weight 0.5: ceil(6 × 0.5) = 3 per run, ceil(12 × 0.5) = 6 per day.
    expect(await sampleCap("disasters")).toMatchObject({ limit_per_run: 3, started_this_run: 2, limit_today: 6, started_today: 5, started_today_total: 5, remaining: 1 });
    await startedAt("2030-01-01T09:30:00Z", 1);
    const full = await sampleCap("disasters");
    expect(full.remaining).toBe(0);
    await expect(requestFreeSample({ prospectId: await seedProspect(db), actor: "sourcing" })).rejects.toThrow(/disasters: 6\/6 today at weight/);
  });

  it("caps the day across playbooks too, since the rounded-up shares add up to more than the cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
    // Shares at the default weights: disasters 6, deforestation 4, mining 3 = 13 > 12.
    await startedAt("2030-01-01T08:00:00Z", 4, "deforestation");
    await startedAt("2030-01-01T08:00:00Z", 3, "mining");
    await startedAt("2030-01-01T09:00:00Z", 5);
    expect(await sampleCap("disasters")).toMatchObject({ limit_today: 6, started_today: 5, limit_today_total: 12, started_today_total: 12, remaining: 0 });
    await expect(requestFreeSample({ prospectId: await seedProspect(db), actor: "sourcing" })).rejects.toThrow(/disasters: 12\/12 today across all playbooks/);
  });

  it("withOneStarted counts a new sample in every window", async () => {
    const after = withOneStarted(await sampleCap("disasters"));
    expect(after).toMatchObject({ started_this_run: 1, started_today: 1, started_today_total: 1, remaining: 2 });
  });

  it("starts one sample when two calls race for the same prospect", async () => {
    const pro = await seedProspect(db);
    const [a, b] = await Promise.all([requestFreeSample({ prospectId: pro, actor: "sourcing" }), requestFreeSample({ prospectId: pro, actor: "sourcing" })]);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
    expect([a.already_requested, b.already_requested].sort()).toEqual([false, true]);
  });

  it("puts the prospect back to matched when the request can't be created", async () => {
    const pro = await seedProspect(db);
    mocks.createRequest.mockRejectedValueOnce(new Error("db down"));
    await expect(requestFreeSample({ prospectId: pro, actor: "sourcing" })).rejects.toThrow("db down");
    const [p] = await db.query<{ status: string; sample_request_id: string | null }>("SELECT status, sample_request_id FROM prospects WHERE id = $1", [pro]);
    expect(p).toEqual({ status: "matched", sample_request_id: null });
    expect((await requestFreeSample({ prospectId: pro, actor: "sourcing" })).already_requested).toBe(false);
  });

  it("keeps the request when the handoff fails, and retries the handoff on the next call", async () => {
    mocks.handoff.mockRejectedValueOnce(new Error("board down"));
    const pro = await seedProspect(db);
    const res = await requestFreeSample({ prospectId: pro, actor: "sourcing" });
    expect(res.warnings).toEqual(["request created but handoff to planner failed: board down. Call request_free_sample again to retry the handoff."]);

    expect(await requestFreeSample({ prospectId: pro, actor: "sourcing" })).toEqual({ request_id: res.request_id, already_requested: true, handoff_retried: true, warnings: [] });
    expect(mocks.handoff).toHaveBeenCalledTimes(2);
    const [r] = await db.query<{ stage: string; owner_agent: string }>("SELECT stage, owner_agent FROM requests WHERE id = $1", [res.request_id]);
    expect(r).toEqual({ stage: "planning", owner_agent: "planner" });
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it("refuses prospects that are not matched", async () => {
    await expect(requestFreeSample({ prospectId: await seedProspect(db, { status: "opted_out" }), actor: "sourcing" })).rejects.toThrow(/opted_out/);
  });
});

describe("sampleQuestion", () => {
  it("phrases mining as indicators, never deposits", () => {
    const q = sampleQuestion({ company: "Ridge Gold", asset_description: "Claim block NV-12", asset_lat: 40.1, asset_lon: -117.2 }, "mining", null);
    expect(q).toMatch(/indicators only, never deposits/);
    expect(q).toContain("Location: 40.1, -117.2.");
  });
});
