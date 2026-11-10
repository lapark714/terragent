import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { listDueMonitors, recordMonitorCheck } from "./monitors";
import { freshDb, insert, reset, seedProspect, seedRequest } from "./testing";

const mocks = vi.hoisted(() => ({ createRequest: vi.fn(), handoff: vi.fn() }));
vi.mock("../pipeline/requests", () => ({ createRequest: mocks.createRequest, handoff: mocks.handoff }));
vi.mock("../email/optout", () => ({ isSuppressed: async () => false }));

let db: Db;
let counter = 0;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
  vi.clearAllMocks();
  mocks.handoff.mockResolvedValue({ card_id: "crd_1" });
  mocks.createRequest.mockImplementation(async (input: { source: string; playbook: string; question: string }) => {
    const id = `req_f${++counter}`;
    await insert(db, "requests", { id, source: input.source, playbook: input.playbook, question: input.question });
    return { id };
  });
});

async function seedMonitor(over: Record<string, unknown> = {}, request: Record<string, unknown> = {}) {
  const requestId = await seedRequest(db, { source: "portal", is_free_sample: false, priority: "inbound", status: "delivered", customer_email: "ann@farm.test", thread_id: "thd_9", inbox: "hello", ...request });
  const id = `mon_t${++counter}`;
  await insert(db, "monitors", {
    id, request_id: requestId, lat: 33.45, lon: -111.94, recipe: "flood_extent", metric: "mndwi", threshold: 0.2, cadence: "0 14 * * 1",
    last_value: 0.1, last_scene_date: "2026-11-01", last_checked_at: new Date("2026-11-02T15:00:00Z"), created_at: new Date("2026-10-30T00:00:00Z"), ...over,
  });
  return { id, requestId };
}

describe("listDueMonitors", () => {
  it("returns active monitors whose cron time passed since the last check (or creation)", async () => {
    const due = await seedMonitor();
    await seedMonitor({ last_checked_at: new Date("2026-11-09T14:30:00Z") });
    await seedMonitor({ status: "paused" });
    const never = await seedMonitor({ last_checked_at: null, created_at: new Date("2026-11-09T13:00:00Z") });
    const res = await listDueMonitors({ now: new Date("2026-11-09T15:00:00Z") });
    expect(res.due.map((m) => m.id).sort()).toEqual([due.id, never.id].sort());
    expect(res.due.find((m) => m.id === due.id)).toMatchObject({ kind: "customer", last_scene_date: "2026-11-01", bbox: expect.any(Array) });
  });

  it("a monitor created moments ago and never checked is due on the very next run (DoD 5 within the weekend)", async () => {
    const fresh = await seedMonitor({ last_checked_at: null, created_at: new Date("2026-11-09T14:59:00Z") });
    const res = await listDueMonitors({ now: new Date("2026-11-09T15:00:00Z") });
    expect(res.due.map((m) => m.id)).toContain(fresh.id);
  });
});

describe("recordMonitorCheck", () => {
  it("no new scene and no change: moves last_checked_at, logs a monitoring decision, no follow-up", async () => {
    const m = await seedMonitor();
    const res = await recordMonitorCheck({ monitorId: m.id, value: null, sceneDate: null, actor: "analytics" });
    expect(res).toMatchObject({ new_scene: false, crossed_threshold: false, followup_request_id: null });
    const [row] = await db.query<{ last_checked_at: Date; last_value: number }>("SELECT last_checked_at, last_value FROM monitors WHERE id = $1", [m.id]);
    expect(row.last_checked_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.last_value).toBe(0.1);
    const [d] = await db.query<{ kind: string; choice: string }>("SELECT kind, choice FROM decisions");
    expect(d).toEqual({ kind: "monitoring", choice: "no follow-up" });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("a change over the threshold on a customer monitor starts a follow-up to comms-customer in their thread", async () => {
    const m = await seedMonitor();
    const res = await recordMonitorCheck({ monitorId: m.id, value: 0.45, sceneDate: "2026-11-08", sceneId: "sentinel-2-l2a:S2B_1", actor: "analytics" });
    expect(res).toMatchObject({ new_scene: true, crossed_threshold: true, followup_to: "comms-customer" });
    expect(res.change).toBeCloseTo(0.35, 6);

    expect(mocks.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      source: "monitor", priority: "background", threadId: "thd_9", inbox: "hello", email: "ann@farm.test", actor: "analytics",
      meta: expect.objectContaining({ monitor_id: m.id, parent_request_id: m.requestId }),
    }));
    expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({ requestId: res.followup_request_id, to: "comms-customer", stage: "delivery" }));
    const [req] = await db.query<{ monitor_id: string }>("SELECT monitor_id FROM requests WHERE id = $1", [res.followup_request_id]);
    expect(req.monitor_id).toBe(m.id);

    const [mon] = await db.query<{ last_value: number; last_scene_date: string }>("SELECT last_value, last_scene_date::text AS last_scene_date FROM monitors WHERE id = $1", [m.id]);
    expect(mon).toEqual({ last_value: 0.45, last_scene_date: "2026-11-08" });
    const [ei] = await db.query<{ change_flag: boolean; source: string; layer: string }>("SELECT change_flag, source, layer FROM earth_index");
    expect(ei).toEqual({ change_flag: true, source: "sentinel-2-l2a:S2B_1", layer: "disasters" });
  });

  it("a cloudy scene is not new information and does not move last_scene_date", async () => {
    const m = await seedMonitor();
    const res = await recordMonitorCheck({ monitorId: m.id, value: 0.9, sceneDate: "2026-11-08", clearScene: false, actor: "analytics" });
    expect(res).toMatchObject({ new_scene: false, crossed_threshold: false, followup_request_id: null });
    const [mon] = await db.query<{ d: string; v: number }>("SELECT last_scene_date::text AS d, last_value AS v FROM monitors WHERE id = $1", [m.id]);
    expect(mon).toEqual({ d: "2026-11-01", v: 0.1 });
  });

  it("a new clear scene alone is not news to a prospect: no follow-up below the threshold", async () => {
    const pro = await seedProspect(db, { status: "emailed", channel: "email_warm" });
    const m = await seedMonitor({}, { prospect_id: pro, is_free_sample: true, source: "signal" });
    const res = await recordMonitorCheck({ monitorId: m.id, value: 0.12, sceneDate: "2026-11-08", actor: "analytics" });
    expect(res).toMatchObject({ new_scene: true, crossed_threshold: false, followup_request_id: null, reason: expect.stringMatching(/threshold/) });
    expect(mocks.handoff).not.toHaveBeenCalled();
  });

  it("a change over the threshold for an emailed prospect goes to comms-outreach and is visible to list_followups", async () => {
    const pro = await seedProspect(db, { status: "emailed", channel: "email_warm" });
    const m = await seedMonitor({}, { prospect_id: pro, is_free_sample: true, source: "signal" });
    const res = await recordMonitorCheck({ monitorId: m.id, value: 0.45, sceneDate: "2026-11-08", actor: "analytics" });
    expect(res).toMatchObject({ new_scene: true, crossed_threshold: true, followup_to: "comms-outreach" });
    expect(mocks.handoff).toHaveBeenCalledWith(expect.objectContaining({ to: "comms-outreach", stage: "outreach" }));
    const [ev] = await db.query<{ payload: { prospect_id: string; new_info: string } }>("SELECT payload FROM events WHERE type = 'monitor.followup'");
    expect(ev.payload.prospect_id).toBe(pro);
    expect(ev.payload.new_info).toMatch(/new clear scene 2026-11-08/);
  });

  it("does not follow up with prospects reached only by contact form", async () => {
    const pro = await seedProspect(db, { status: "emailed", channel: "contact_form" });
    const m = await seedMonitor({}, { prospect_id: pro });
    const res = await recordMonitorCheck({ monitorId: m.id, value: 0.9, sceneDate: "2026-11-08", actor: "analytics" });
    expect(res).toMatchObject({ crossed_threshold: true, followup_request_id: null, reason: expect.stringMatching(/contact forms get one touch/) });
    const [d] = await db.query<{ choice: string }>("SELECT choice FROM decisions");
    expect(d.choice).toBe("new information, no follow-up");
  });

  it("refuses unknown or inactive monitors", async () => {
    const m = await seedMonitor({ status: "cancelled" });
    await expect(recordMonitorCheck({ monitorId: "mon_nope", value: 1, sceneDate: null, actor: "analytics" })).rejects.toThrow(/not found/);
    await expect(recordMonitorCheck({ monitorId: m.id, value: 1, sceneDate: null, actor: "analytics" })).rejects.toThrow(/cancelled/);
  });
});
