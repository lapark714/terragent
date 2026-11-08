/**
 * Pricing v2 for API clients: a request made through POST /api/answer usually has no email, so its quote reaches the
 * client only through GET /api/answer/{id}. That response must carry the options and how to accept, and accepting with
 * it (POST /api/quotes/accept) must start the analysis. Real pipeline services, in-memory database, no lanes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiKey, resetMemoryLimits, tagApiRequest } from "@/lib/api-keys";
import { invalidateDashboard } from "@/lib/dashboard/cache";
import { setDb } from "@/lib/db/client";
import { logDecision } from "@/lib/events";
import { saveAcquisitionPlan } from "@/lib/pipeline/acquisition";
import { createQuote } from "@/lib/pipeline/quotes";
import { createRequest, getRequest, mergeMeta } from "@/lib/pipeline/requests";
import { saveDataSpec } from "@/lib/pipeline/specs";
import { samplePlan, sampleSpec, SITE, setupMemoryDb } from "@/lib/pipeline/testing";

const { GET } = await import("./[id]/route");
const { POST: accept } = await import("../quotes/accept/route");

let close: () => Promise<void>;
beforeAll(async () => {
  const db = await setupMemoryDb();
  close = () => db.close();
});
beforeEach(() => {
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
  vi.stubEnv("TERRAGENT_LANES", "off");
  resetMemoryLimits();
  invalidateDashboard();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  setDb(null);
  await close();
});

const get = (id: string, key: string) =>
  GET(new Request(`http://localhost/api/answer/${id}`, { headers: { authorization: `Bearer ${key}` } }), { params: Promise.resolve({ id }) });

describe("an API request (no email) and its quote", () => {
  it("shows the options and a ready-to-send accept call; accepting it starts analytics", async () => {
    const key = await createApiKey("agent-client", 10);
    const req = await createRequest({ question: "Did the fire reach the depot?", lat: SITE.lat, lon: SITE.lon, source: "api" });
    await tagApiRequest(req.id, key);
    await mergeMeta(req.id, { screening: { allowed: true } });
    await saveDataSpec(sampleSpec(req.id), "planner");
    for (const kind of ["free_vs_paid", "source_selection"] as const) {
      await logDecision({ requestId: req.id, kind, choice: "free", reasoning: "Sentinel-2 is enough", agent: "acquisition" });
    }
    await saveAcquisitionPlan(samplePlan(req.id), "acquisition");
    const created = await createQuote({ requestId: req.id }, "pricing");
    if ("error" in created) throw new Error(created.error);
    expect(created.handoff).toBeNull(); // no email or thread: nobody to send it to but the API client

    const body = await (await get(req.id, key.key)).json();
    expect(body.status).toBe("quoted");
    expect(body.quote).toMatchObject({
      status: "approved", auto_approved: false, price_usd: 29, recommended_option_id: "A", accepted_option_id: null,
      valid_until: expect.any(String), closed_reason: null, accept_url: expect.stringMatching(/^https:\/\/terragent\.test\/quote\/[A-Za-z0-9]{24}$/),
      accept: { method: "POST", url: "https://terragent.test/api/quotes/accept", body: { token: expect.any(String), option_id: "A" } },
    });
    expect(body.quote.options[0]).toMatchObject({ option_id: "A", kind: "free_data", price_usd: 29, recommended: true });
    expect(JSON.stringify(body.quote.options)).not.toMatch(/margin|analysis_cost|unit_price/);
    expect(body.quote.accept_url.endsWith(body.quote.accept.body.token)).toBe(true);
    expect((await getRequest(req.id))?.owner_agent).not.toBe("analytics");

    const res = await accept(new Request("http://localhost/api/quotes/accept", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.0.1" }, body: JSON.stringify(body.quote.accept.body),
    }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ request_id: req.id, status: "analyzing", accepted_option_id: "A", already_accepted: false });
    expect(await getRequest(req.id)).toMatchObject({ status: "analyzing", owner_agent: "analytics", stage: "analysis" });

    invalidateDashboard();
    const after = await (await get(req.id, key.key)).json();
    expect(after.quote).toMatchObject({ status: "accepted", accepted_option_id: "A", closed_reason: "accepted", accept_url: null, accept: null });
  });
});
