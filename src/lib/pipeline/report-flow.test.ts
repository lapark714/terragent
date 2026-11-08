import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS } from "../config";
import { getDb } from "../db/client";
import { VERIFIER_CHECKS, type Verdict } from "../domain";
import { replyInThread, sendEmail } from "../email/send";
import { logDecision } from "../events";
import { startAgentSession } from "../naive/sessions";
import { setSetting, SETTING } from "../settings";
import { acceptQuote } from "./acceptance";
import { saveAcquisitionPlan } from "./acquisition";
import { getAnalysisJob, saveAnalysis } from "./analyses";
import { deliverReport } from "./deliver";
import { lookupEarthIndex } from "./earth-index";
import { createMonitor } from "./monitors";
import { createQuote } from "./quotes";
import { saveReportDraft } from "./reports";
import { checkReportRules } from "./rules";
import { createRequest, getRequest, mergeMeta } from "./requests";
import { MAX_AOI_KM2, MAX_CELLS, saveDataSpec } from "./specs";
import { bboxAround, bboxToPolygon } from "../geo/h3";
import { SAMPLE_FILE_IDS, sampleAnalysis, sampleDraft, samplePlan, sampleSpec, SITE, setupMemoryDb } from "./testing";
import { saveVerdict } from "./verdicts";

vi.mock("../naive/sessions", () => ({ startAgentSession: vi.fn(async () => ({ session_id: `ses_${Math.random().toString(36).slice(2, 10)}` })) }));
vi.mock("../naive/board", () => ({ upsertCard: vi.fn(async () => ({ id: "crd_x" })) }));
vi.mock("../naive/spend", () => ({ sessionCostUsd: vi.fn(async () => 0.2) }));
vi.mock("../email/send", () => ({
  sendEmail: vi.fn(async () => ({ status: "sent", message_id: "msg_1", thread_id: "thd_new" })),
  replyInThread: vi.fn(async () => ({ status: "sent", message_id: "msg_2", thread_id: "thd_in" })),
}));
vi.mock("../email/threads", () => ({
  getThread: vi.fn(async (id: string) => ({ thread_id: id, inbox: "hello", messages: [{ direction: "inbound", agentmail_message_id: "<m1@x>", from: "a@example.com", to: [], subject: "Q", text: "hi", at: "" }] })),
}));
vi.mock("../email/templates", () => ({
  renderReportDelivery: (a: { report: { url: string } }) => ({ subject: "Your report", text: `See ${a.report.url}`, html: "<p/>" }),
  requestStatusUrl: (id: string) => `https://terragent.test/request/${id}`,
}));

beforeAll(async () => {
  await setupMemoryDb();
});
beforeEach(() => vi.clearAllMocks());

/** A screened inbound request with spec, free plan and saved analysis — ready for Brain 2. */
async function analysedRequest(over: { threadId?: string; email?: string } = {}) {
  const req = await createRequest({ question: "Did the January fire burn our block?", lat: SITE.lat, lon: SITE.lon, source: "portal", email: over.email ?? "a@example.com", threadId: over.threadId });
  await mergeMeta(req.id, { screening: { allowed: true } });
  await saveDataSpec(sampleSpec(req.id), "planner");
  for (const kind of ["free_vs_paid", "source_selection"] as const) {
    await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
  }
  await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
  await createQuote({ requestId: req.id }, "pricing");
  await acceptQuote({ requestId: req.id, actor: "comms-customer", evidence: "Yes, go ahead" }); // pricing v2: work starts only on an accepted option
  await saveAnalysis({ requestId: req.id, result: sampleAnalysis(), fileIds: SAMPLE_FILE_IDS }, "analytics");
  return req;
}

const verdict = (reportId: string, pass: boolean): Verdict => ({
  report_id: reportId, pass, score: pass ? 92 : 40,
  checks: VERIFIER_CHECKS.map((id) => ({ id, pass, note: pass ? "ok" : "weak" })),
  required_fixes: pass ? [] : ["Explain the dNBR classes in plain words"],
});

describe("data spec and plan", () => {
  it("covers the AOI with H3 cells and recomputes the area", async () => {
    const req = await createRequest({ question: "Has the vegetation recovered?", source: "portal" });
    const res = await saveDataSpec(sampleSpec(req.id, { area_km2: 40 }), "planner");
    expect(res.area_km2).toBeGreaterThan(3.8);
    expect(res.h3_cells).toBeGreaterThan(2);
    expect(res.warnings[0]).toMatch(/recomputed/);
    const row = await getRequest(req.id);
    expect(row?.lat).toBe(SITE.lat);
    expect(row?.aoi).toEqual(sampleSpec(req.id).aoi);
  });

  it("refuses region-sized AOIs and covers that would bloat the request row", async () => {
    const req = await createRequest({ question: "Is the whole county flooded?", source: "portal" });
    const huge = bboxToPolygon(bboxAround(SITE.lat, SITE.lon, 200)); // ~40,000 km²
    await expect(saveDataSpec(sampleSpec(req.id, { aoi: huge, area_km2: 40000 }), "planner")).rejects.toThrow(new RegExp(`limit is ${MAX_AOI_KM2}`));
    const big = bboxToPolygon(bboxAround(SITE.lat, SITE.lon, 30)); // ~900 km², fine at res 8, too many cells at res 10
    await expect(saveDataSpec(sampleSpec(req.id, { aoi: big, area_km2: 900, h3_res: 10 }), "planner")).rejects.toThrow(new RegExp(`limit ${MAX_CELLS}`));
    expect((await saveDataSpec(sampleSpec(req.id, { aoi: big, area_km2: 900, h3_res: 8 }), "planner")).h3_cells).toBeLessThan(MAX_CELLS);
    expect((await getRequest(req.id))?.h3_cells.length).toBeLessThan(MAX_CELLS);
  });

  it("requires the free-vs-paid and source decisions, and a reason for paid", async () => {
    const req = await createRequest({ question: "Check the roof damage after hail", source: "portal" });
    await saveDataSpec(sampleSpec(req.id), "planner");
    await expect(saveAcquisitionPlan(samplePlan(req.id), "acquisition")).rejects.toThrow(/free_vs_paid and source_selection/);
    for (const kind of ["free_vs_paid", "source_selection"] as const) {
      await logDecision({ requestId: req.id, kind, choice: "paid", reasoning: "hail damage", agent: "acquisition" });
    }
    await expect(saveAcquisitionPlan(samplePlan(req.id, { choice: "paid", justification: "sharper" }), "acquisition")).rejects.toThrow(/justification/);
    const ok = await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
    expect(ok.next).toEqual({ to: "pricing", stage: "pricing" });
  });
});

describe("analysis and the Earth index", () => {
  it("writes derived per-cell metrics with layer, scene date, source and change flags", async () => {
    const req = await analysedRequest();
    const rows = await (await getDb()).query<{ layer: string; metric: string; change_flag: boolean; source: string; observed_at: Date }>(
      "SELECT layer, metric, change_flag, source, observed_at FROM earth_index WHERE request_id = $1 ORDER BY value DESC", [req.id]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ layer: "inbound", metric: "dnbr_mean", change_flag: true, source: expect.stringMatching(/^sentinel-2-l2a:S2C_/) });
    expect(rows.find((r) => r.metric === "nbr_after_mean")?.change_flag).toBe(false); // not a delta metric
    expect(rows.filter((r) => r.change_flag)).toHaveLength(1); // 0.05 is under the 0.27 dNBR threshold

    const found = await lookupEarthIndex({ lat: SITE.lat, lon: SITE.lon, metric: "dnbr_mean" });
    expect(found.hits.length).toBeGreaterThanOrEqual(1);
    expect(found.hits[0]).toMatchObject({ observed_at: "2025-02-01", metric: "dnbr_mean" });
    expect(found.summary[0]).toMatchObject({ metric: "dnbr_mean", changed_cells: 1 });
  });

  it("builds the pipeline job from the spec and plan, with the bundle file id", async () => {
    const req = await analysedRequest();
    await setSetting(SETTING.pipelineBundle, { file_id: "fil_bundle1", sha256: "abc" });
    const job = await getAnalysisJob(req.id);
    expect(job.bundle_file_id).toBe("fil_bundle1");
    expect(job.job).toMatchObject({ request_id: req.id, recipe: "burn_severity", collection: "sentinel-2-l2a", h3_res: 8, max_cloud_pct: 30 });
    expect(job.job.after_scene).toMatchObject({ item_id: expect.stringMatching(/^S2C_/) });
    // Analytics sessions share one computer: each run has its own job file, and runs take a lock.
    expect(job.job_path).toBe(`~/jobs/${req.id}.json`);
    expect(job.steps.join("\n")).toContain(`flock -w 480 ~/tg.lock ~/tg/pipeline/.venv/bin/python -m terragent_pipeline.run --job ~/jobs/${req.id}.json --out ~/out/${req.id}`);
    expect(job.steps.join("\n")).not.toContain("~/job.json");
  });
});

describe("report, verdict and delivery", () => {
  it("turns file ids into public image links and passes the rule checks", async () => {
    const req = await analysedRequest();
    const { report_id, url } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    expect(url).toMatch(/\/r\/[A-Za-z0-9]{24}$/);
    const token = url.split("/r/")[1];
    const [row] = await (await getDb()).query<{ images: { url: string }[] }>("SELECT images FROM reports WHERE id = $1", [report_id]);
    expect(row.images.map((i) => i.url)).toEqual(["fil_before1", "fil_after1", "fil_dnbr1"].map((f) => `http://localhost:3000/api/files/${f}?r=${token}`));
    expect((await checkReportRules(report_id)).hard_failures).toEqual([]);
  });

  it("a pass hands off to Comms 2, links the Earth index rows, and delivery replies in the thread", async () => {
    const req = await analysedRequest({ threadId: "thd_in" });
    const { report_id } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    const res = await saveVerdict(verdict(report_id, true), "verifier");
    expect(res).toMatchObject({ pass: true, handed_off_to: "comms-customer" });
    expect(vi.mocked(startAgentSession).mock.calls.at(-1)?.[0]).toBe("comms-customer");
    const linked = await (await getDb()).query("SELECT 1 FROM earth_index WHERE request_id = $1 AND report_id = $2", [req.id, report_id]);
    expect(linked).toHaveLength(3);

    const sent = await deliverReport(req.id, "comms-customer");
    expect(sent.status).toBe("sent");
    expect(vi.mocked(replyInThread).mock.calls[0][0]).toMatchObject({ inbox: "hello", inReplyToMessageId: "<m1@x>", kind: "customer" });
    expect((await getRequest(req.id))?.status).toBe("delivered");
  });

  it("blocked delivery leaves the request undelivered", async () => {
    vi.mocked(sendEmail).mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "inbox hello not armed" });
    const req = await analysedRequest();
    const { report_id } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    await saveVerdict(verdict(report_id, true), "verifier");
    const res = await deliverReport(req.id, "comms-customer");
    expect(res).toMatchObject({ status: "blocked", blocked_reason: "inbox hello not armed" });
    expect((await getRequest(req.id))?.status).toBe("delivering");
  });

  it("won't pass a report that fails hard rules", async () => {
    const req = await analysedRequest();
    const { report_id } = await saveReportDraft(sampleDraft(req.id, { images: sampleDraft(req.id).images.slice(1) }), "interpreter");
    await expect(saveVerdict(verdict(report_id, true), "verifier")).rejects.toThrow(/has_before_and_after_images/);
  });

  it(`loops back to the Interpreter up to ${CAPS.maxReportRevisions} revisions, then fails the request`, async () => {
    const req = await analysedRequest();
    for (let i = 1; i <= CAPS.maxReportRevisions; i++) {
      const { report_id } = await saveReportDraft(sampleDraft(req.id), "interpreter");
      const res = await saveVerdict(verdict(report_id, false), "verifier");
      expect(res).toMatchObject({ pass: false, revisions: i, handed_off_to: "interpreter" });
      expect((await getRequest(req.id))?.status).toBe("revising");
    }
    const { report_id, revision } = await saveReportDraft(sampleDraft(req.id), "interpreter");
    expect(revision).toBe(CAPS.maxReportRevisions + 1);
    const last = await saveVerdict(verdict(report_id, false), "verifier");
    expect(last).toMatchObject({ pass: false, status: "failed" });
    expect((await getRequest(req.id))?.status).toBe("failed");
    const types = (await (await getDb()).query<{ type: string }>("SELECT type FROM events WHERE request_id = $1", [req.id])).map((e) => e.type);
    expect(types).toContain("coordinator.attention");
  });
});

describe("monitoring", () => {
  it("a repeated create_monitor updates the request's active monitor instead of adding a second", async () => {
    const req = await analysedRequest();
    const evidence = "Yes, monitor it monthly";
    const first = await createMonitor({ requestId: req.id, metric: "dnbr_mean", evidence }, "comms-customer");
    const again = await createMonitor({ requestId: req.id, metric: "dnbr_mean", cadence: "0 9 * * *", evidence }, "comms-customer");
    expect(again).toMatchObject({ monitor_id: first.monitor_id, cadence: "0 9 * * *", updated: true });
    const rows = await (await getDb()).query<{ cadence: string }>("SELECT cadence FROM monitors WHERE request_id = $1", [req.id]);
    expect(rows).toEqual([{ cadence: "0 9 * * *" }]);
  });
});
