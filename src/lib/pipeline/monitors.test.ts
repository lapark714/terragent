/** Monitoring re-checks (DoD 5): monitor mode of get_analysis_job, the default cadence, and auto-monitors on verified samples. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { VERIFIER_CHECKS } from "../domain";
import { logDecision } from "../events";
import { listDueMonitors } from "../outbound/monitors";
import { saveAcquisitionPlan } from "./acquisition";
import { getAnalysisJob, MONITOR_DEFAULT_WINDOW_DAYS, MONITOR_LOOKBACK_DAYS, monitorAfterWindow, saveAnalysis } from "./analyses";
import { createMonitor, DEFAULT_MONITOR_CADENCE } from "./monitors";
import { createQuote } from "./quotes";
import { saveReportDraft } from "./reports";
import { createRequest, mergeMeta } from "./requests";
import { saveDataSpec } from "./specs";
import { SAMPLE_FILE_IDS, sampleAnalysis, sampleDraft, samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";
import { monitorMetricFor, saveVerdict } from "./verdicts";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_m" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllEnvs());

const db = () => getDb();

/** A screened, quoted, analysed request; `delivered` closes it the way deliver_report would. */
async function analysed(o: { delivered?: boolean; freeSample?: boolean; prospectId?: string } = {}) {
  const req = await createRequest({
    question: "Did the fire burn our depot?", lat: SITE.lat, lon: SITE.lon, source: o.freeSample ? "signal" : "portal", email: "ops@depot.test",
    isFreeSample: o.freeSample, prospectId: o.prospectId, playbook: o.freeSample ? "disasters" : undefined,
  });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
  await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
  if (!o.freeSample) await createQuote({ requestId: req.id }, "pricing");
  await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
  if (o.delivered) await (await db()).query("UPDATE requests SET status = 'delivered' WHERE id = $1", [req.id]);
  return req;
}

describe("monitorAfterWindow", () => {
  const now = new Date("2026-11-07T18:00:00Z");
  it("runs from the day after the last scene to today", () => {
    expect(monitorAfterWindow("2026-11-01", now)).toEqual({ start: "2026-11-02", end: "2026-11-07" });
  });
  it("uses the last two weeks when the monitor has never seen a scene", () => {
    expect(MONITOR_DEFAULT_WINDOW_DAYS).toBe(14);
    expect(monitorAfterWindow(null, now)).toEqual({ start: "2026-10-24", end: "2026-11-07" });
  });
  it("never looks back further than the lookback, and never starts after today", () => {
    expect(monitorAfterWindow("2025-02-01", now)).toEqual({ start: "2026-09-08", end: "2026-11-07" });
    expect(MONITOR_LOOKBACK_DAYS).toBe(60);
    expect(monitorAfterWindow("2026-11-07", now)).toEqual({ start: "2026-11-07", end: "2026-11-07" });
  });
});

describe("create_monitor defaults", () => {
  it("re-checks every 12 hours, is never 'checked' at creation, and is due on the next monitors run", async () => {
    const req = await analysed({ delivered: true });
    const m = await createMonitor({ requestId: req.id, metric: "dnbr_mean" }, "comms-customer");
    expect(m.cadence).toBe(DEFAULT_MONITOR_CADENCE);
    expect(DEFAULT_MONITOR_CADENCE).toBe("0 */12 * * *");
    const [row] = await (await db()).query<{ last_checked_at: Date | null; last_scene_date: string }>(
      "SELECT last_checked_at, last_scene_date::text AS last_scene_date FROM monitors WHERE id = $1", [m.monitor_id]);
    expect(row).toEqual({ last_checked_at: null, last_scene_date: "2025-02-01" });

    const ids = async (now: Date) => (await listDueMonitors({ now, limit: 50 })).due.map((d) => d.id);
    // Never checked → due at once, so the first re-check happens on the next 6-hourly analytics-monitors run
    // rather than up to ~18 h later (DoD 5 has to show a re-check before judging).
    expect(await ids(new Date())).toContain(m.monitor_id);
  });

  it("takes MONITOR_DEFAULT_CADENCE from the environment, ignoring a malformed value", async () => {
    vi.stubEnv("MONITOR_DEFAULT_CADENCE", "0 */4 * * *");
    expect((await createMonitor({ requestId: (await analysed()).id, metric: "dnbr_mean" }, "comms-customer")).cadence).toBe("0 */4 * * *");
    vi.stubEnv("MONITOR_DEFAULT_CADENCE", "often");
    expect((await createMonitor({ requestId: (await analysed()).id, metric: "dnbr_mean" }, "comms-customer")).cadence).toBe(DEFAULT_MONITOR_CADENCE);
  });
});

describe("get_analysis_job in monitor mode", () => {
  it("re-checks a delivered request: baseline kept, after window re-opened, no pinned after scene, own job file", async () => {
    const req = await analysed({ delivered: true });
    await expect(getAnalysisJob(req.id)).rejects.toThrow(/is delivered/); // a plain job still refuses a finished request
    const { monitor_id } = await createMonitor({ requestId: req.id, metric: "dnbr_mean" }, "comms-customer");

    const now = new Date("2025-02-20T10:00:00Z");
    const res = await getAnalysisJob(req.id, { monitorId: monitor_id, now });
    const plain = samplePlan(req.id).free_option!;
    expect(res).toMatchObject({ mode: "monitor", monitor_id, measure: { metric: "dnbr_mean", field: "delta", last_scene_date: "2025-02-01" } });
    expect(res.job).toMatchObject({
      request_id: req.id, recipe: "burn_severity", before_window: sampleSpec(req.id).before, before_scene: plain.before_scene,
      after_window: { start: "2025-02-02", end: "2025-02-20" }, after_scene: null,
    });
    expect(res.job_path).toBe(`~/jobs/${req.id}-${monitor_id}.json`);
    const steps = res.steps.join("\n");
    expect(steps).toContain(`--job ~/jobs/${req.id}-${monitor_id}.json --out ~/out/${req.id}-${monitor_id}`);
    expect(steps).toMatch(/Do NOT save_analysis/);
    expect(steps).toContain(`record_monitor_check { monitor_id: "${monitor_id}"`);
  });

  it("measures after_mean for a level metric", async () => {
    const req = await analysed({ delivered: true });
    const { monitor_id } = await createMonitor({ requestId: req.id, metric: "nbr_after_mean" }, "comms-customer");
    expect(await getAnalysisJob(req.id, { monitorId: monitor_id })).toMatchObject({ measure: { field: "after_mean" } });
  });

  it("refuses an unknown monitor, another request's monitor and a stopped one", async () => {
    const a = await analysed({ delivered: true });
    const b = await analysed({ delivered: true });
    const { monitor_id } = await createMonitor({ requestId: a.id, metric: "dnbr_mean" }, "comms-customer");
    await expect(getAnalysisJob(a.id, { monitorId: "mon_nope" })).rejects.toThrow(/Unknown monitor/);
    await expect(getAnalysisJob(b.id, { monitorId: monitor_id })).rejects.toThrow(new RegExp(`watches ${a.id}`));
    await (await db()).query("UPDATE monitors SET status = 'cancelled' WHERE id = $1", [monitor_id]);
    await expect(getAnalysisJob(a.id, { monitorId: monitor_id })).rejects.toThrow(/cancelled/);
  });
});

describe("save_analysis on a shared computer", () => {
  it("refuses a result whose bbox or recipe belongs to another job", async () => {
    const req = await analysed();
    const elsewhere = sampleAnalysis({ bbox: [-122.5, 37.7, -122.4, 37.8] });
    await expect(saveAnalysis({ requestId: req.id, result: elsewhere, fileIds: SAMPLE_FILE_IDS }, "analytics")).rejects.toThrow(/not req_\w+'s job/);
    await expect(saveAnalysis({ requestId: req.id, result: sampleAnalysis({ recipe: "vegetation_health" }), fileIds: SAMPLE_FILE_IDS }, "analytics"))
      .rejects.toThrow(/another session's run/);
    expect((await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics")).analysis_id).toMatch(/^ana_/);
  });
});

describe("auto-monitor on a verified free sample", () => {
  async function verifiedSample(channel: string) {
    const prospectId = `pro_${channel.replace(/\W/g, "")}${Math.random().toString(36).slice(2, 6)}`;
    await (await db()).query(
      "INSERT INTO prospects (id, playbook, company, contact_email, status, channel) VALUES ($1, 'disasters', 'Depot Co', 'ops@depot.test', 'sample_requested', $2)",
      [prospectId, channel]);
    const req = await analysed({ freeSample: true, prospectId });
    const { report_id } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    return saveVerdict({ report_id, pass: true, score: 95, checks: VERIFIER_CHECKS.map((id) => ({ id, pass: true, note: "ok" })), required_fixes: [] }, "verifier");
  }

  it("watches the site when the prospect can get an emailed follow-up", async () => {
    const res = await verifiedSample("email_warm");
    expect(res).toMatchObject({ pass: true, handed_off_to: "comms-outreach", monitor_id: expect.stringMatching(/^mon_/) });
    const [m] = await (await db()).query<{ metric: string; cadence: string }>("SELECT metric, cadence FROM monitors WHERE id = $1", [(res as { monitor_id?: string }).monitor_id]);
    expect(m).toEqual({ metric: "dnbr", cadence: DEFAULT_MONITOR_CADENCE });
  });

  it("does not for contact-form prospects (one touch only)", async () => {
    const res = await verifiedSample("contact_form");
    expect(res).toMatchObject({ pass: true });
    expect(res).not.toHaveProperty("monitor_id");
  });

  it("picks a change index first, else the first before/after delta", () => {
    expect(monitorMetricFor(sampleAnalysis())).toBe("dnbr");
    expect(monitorMetricFor({ indices: [{ name: "ndvi", before_mean: 0.5, after_mean: 0.3, delta: -0.2, unit: null, affected_area_km2: null, threshold: null }] })).toBe("ndvi_delta");
    expect(monitorMetricFor({ indices: [] })).toBeNull();
  });
});
