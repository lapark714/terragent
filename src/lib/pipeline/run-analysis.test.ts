import { beforeAll, describe, expect, it, vi } from "vitest";
import { getDb } from "../db/client";
import { logDecision } from "../events";
import type { NaiveRunResult } from "../naive/compute";
import { acceptQuote } from "./acceptance";
import { saveAcquisitionPlan } from "./acquisition";
import { getAnalysisView } from "./analyses";
import { createMonitor } from "./monitors";
import { createQuote } from "./quotes";
import { createRequest, mergeMeta } from "./requests";
import { monitorReading, runAnalysis } from "./run-analysis";
import { saveDataSpec } from "./specs";
import { SAMPLE_FILE_IDS, sampleAnalysis, samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_new" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_in" })),
}));

beforeAll(async () => {
  await setupMemoryDb();
});

/** A request with spec, free plan and an accepted quote: ready for the pipeline. */
async function readyRequest() {
  const req = await createRequest({ question: "Did the January fire burn our block?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: "a@example.com" });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
  await createQuote({ requestId: req.id }, "pricing");
  await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Yes, go ahead" });
  return req;
}

/** A fake runner that echoes the job's bbox and recipe, like the real pipeline does. */
const fakeRun = (over: Parameters<typeof sampleAnalysis>[0] = {}) =>
  vi.fn(async (job: Record<string, unknown>): Promise<NaiveRunResult> => ({
    result: sampleAnalysis({ bbox: job.bbox as never, recipe: job.recipe as never, ...over }),
    fileIds: SAMPLE_FILE_IDS, timings: { total_s: 31 }, installed: false,
  }));

describe("run_analysis", () => {
  it("runs the request's job server-side, saves the result and points to the interpreter", async () => {
    const req = await readyRequest();
    const run = fakeRun();
    const out = await runAnalysis({ requestId: req.id }, "analytics", run);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ recipe: "burn_severity" }), req.id);
    expect(out).toMatchObject({ mode: "request", result: { images: 3, before_date: "2025-01-02" }, next: expect.stringMatching(/interpreter/) });
    const view = await getAnalysisView(req.id);
    expect(JSON.stringify(view)).toContain("fil_dnbr1");
  });

  it("records a monitor re-check on the monitor, and records a failed run as a null check", async () => {
    const req = await readyRequest();
    await runAnalysis({ requestId: req.id }, "analytics", fakeRun());
    const db = await getDb();
    await db.query("UPDATE requests SET status = 'delivered' WHERE id = $1", [req.id]);
    const { monitor_id } = await createMonitor({ requestId: req.id, metric: "dnbr_mean", evidence: "Yes, monitor it monthly at $49" }, "comms-customer");

    const later = { collection: "sentinel-2-l2a", item_id: "S2B_LATER", datetime: "2025-03-03T18:40:00Z", cloud_pct: 2, clear_fraction: 0.99 };
    const indices = sampleAnalysis().indices.map((i) => (i.name === "dnbr" ? { ...i, delta: 0.18 } : i));
    const out = await runAnalysis({ requestId: req.id, monitorId: monitor_id }, "analytics", fakeRun({ after: later, indices }));
    expect(out).toMatchObject({ mode: "monitor", reading: { index: "dnbr", value: 0.18, scene_date: "2025-03-03", scene_id: "sentinel-2-l2a:S2B_LATER" } });
    const [m] = await db.query<{ last_value: number; last_scene_date: string }>("SELECT last_value, last_scene_date::text AS last_scene_date FROM monitors WHERE id = $1", [monitor_id]);
    expect(m).toEqual({ last_value: 0.18, last_scene_date: "2025-03-03" });

    const failing = vi.fn(async () => { throw new Error("planetary computer timeout"); });
    const failed = await runAnalysis({ requestId: req.id, monitorId: monitor_id }, "analytics", failing);
    expect(failed).toMatchObject({ mode: "monitor", error: expect.stringMatching(/planetary computer timeout/) });
  });

  it("monitorReading takes the longest matching index and reads nothing without an after scene", () => {
    const r = sampleAnalysis();
    expect(monitorReading(r, "dnbr_mean")).toMatchObject({ index: "dnbr", value: 0.174 });
    expect(monitorReading(r, "nbr_after_mean")).toMatchObject({ index: "nbr", value: 0.052 });
    expect(monitorReading(sampleAnalysis({ after: null }), "dnbr_mean")).toEqual({ index: "dnbr", value: null, scene_date: null, scene_id: undefined });
  });
});
