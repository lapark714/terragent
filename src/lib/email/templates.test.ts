import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { seedTemplates, TEMPLATE_SEEDS } from "./template-library";
import {
  AI_DISCLOSURE, ensureCompliance, fillTemplate, HUMAN_REVIEW_NOTE, MONITORING_OFFER, renderClarifyingQuestion, renderFollowup, renderOutreach,
  renderCustomerUpdate, renderQuote, renderRefusal, renderReportDelivery, renderSupplierQuoteRequest, TemplateError, type ReportForEmail,
} from "./templates";
import { memoryDb } from "./testing";

const report: ReportForEmail = {
  id: "rpt_1", title: "Flood check: 1 Main St", answer: "Standing water covered about 40% of the lot on Nov 3.", confidence: "medium",
  limitations: "10 m resolution; one partly cloudy scene.", human_review_recommended: true, url: "https://terragent.test/r/abc",
  images: [
    { role: "after", url: "https://img.test/after.png", caption: "After, 2026-11-03" },
    { role: "before", url: "https://img.test/before.png", caption: "Before, 2026-10-20" },
  ],
  measurements: [{ metric: "Flooded area", value: 0.123456, unit: "km²", note: "MNDWI > 0.2" }, { metric: "NDVI change", value: null, unit: null }],
  sources: [{ name: "Sentinel-2 L2A", datetime: "2026-11-03T16:02:11Z" }],
};
const OPT_OUT = "https://terragent.test/unsubscribe?t=TOKEN123";

afterEach(() => vi.unstubAllEnvs());

describe("fillTemplate", () => {
  it("substitutes placeholders and fallbacks", () => {
    expect(fillTemplate("Hi {{contact_name|there}}, {{company}}", { company: "Acme" })).toBe("Hi there, Acme");
    expect(fillTemplate("Hi {{ contact_name }}", { contact_name: "Pat" })).toBe("Hi Pat");
  });

  it("fails closed on unknown or empty placeholders", () => {
    expect(() => fillTemplate("Price: {{price}}", {})).toThrow(TemplateError);
    expect(() => fillTemplate("Price: {{price}}", { price: "  " })).toThrow(/price/);
    expect(() => fillTemplate("Broken {{price", { price: "$1" })).toThrow(TemplateError);
    expect(() => fillTemplate("Hi {{company}}", { company: "{{contact_name}}" })).toThrow(TemplateError);
  });

  it("allows stray braces inside values (a finding quoting JSON)", () => {
    expect(fillTemplate("Found: {{finding}}", { finding: 'water at {"x": {"y": 1}}' })).toBe('Found: water at {"x": {"y": 1}}');
  });
});

describe("outreach", () => {
  const template = { subject: "Satellite check of {{asset}}", body: "Hi {{contact_name|there}},\n\nWhat we found: {{finding}}\n\nReport: {{report_url}} ({{price}})" };
  const vars = { asset: "the Elm St warehouse", finding: "water reached the loading dock", price: "$49/month" };

  it("includes the asset image, the finding, next step + price, identity, AI disclosure and opt-out", () => {
    vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Test Way, Testville, CA 90000");
    const e = renderOutreach({ template, vars, report, optOutUrl: OPT_OUT });
    expect(e.subject).toBe("Satellite check of the Elm St warehouse");
    for (const part of ["water reached the loading dock", "https://img.test/after.png", "$49/month", report.url, AI_DISCLOSURE, OPT_OUT, "1 Test Way"]) {
      expect(e.text).toContain(part);
    }
    expect(e.html).toContain('<img src="https://img.test/after.png"');
    expect(e.html).toContain(OPT_OUT);
    expect(e.text).not.toMatch(/\{\{|\}\}/);
  });

  it("refuses to render without an image or with an unknown placeholder", () => {
    expect(() => renderOutreach({ template, vars, report: { ...report, images: [] }, optOutUrl: OPT_OUT })).toThrow(/image/);
    expect(() => renderOutreach({ template: { ...template, body: "{{mystery}}" }, vars, report, optOutUrl: OPT_OUT })).toThrow(TemplateError);
  });

  it("escapes variables in HTML", () => {
    const e = renderOutreach({ template, vars: { ...vars, finding: "<script>x</script>" }, report, optOutUrl: OPT_OUT });
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
  });

  it("every seed renders with the playbook's variables and passes the compliance footer", () => {
    const all = { ...vars, event: "the Nov 2 flood", place: "Houston, TX", company: "Acme", new_info: "the water has receded" };
    for (const seed of TEMPLATE_SEEDS) {
      const e = renderOutreach({ template: seed, vars: all, report, optOutUrl: OPT_OUT });
      expect(e.text).toContain(AI_DISCLOSURE);
      expect(e.text).toContain(OPT_OUT);
      if (seed.playbook === "mining") expect(e.text).toMatch(/not evidence of a deposit/);
      if (seed.playbook === "disasters") expect(e.text).toMatch(/not adjusters or contractors/);
    }
  });

  it("follow-up defaults to the library template and a monitoring price", () => {
    const e = renderFollowup({ contactName: "Pat", company: "Acme", newInfo: "the water has receded", report, optOutUrl: OPT_OUT });
    expect(e.subject).toBe("New satellite image for Acme");
    expect(e.text).toContain("Hi Pat,");
    expect(e.text).toContain("the water has receded");
    expect(e.text).toMatch(/\$49 per site per month/);
    expect(e.text).toContain(OPT_OUT);
  });
});

describe("customer and supplier emails", () => {
  it("report delivery has answer, confidence, measurements, images, dated sources, limitations, review note, link, price", () => {
    const e = renderReportDelivery({ customerName: "Pat", question: "Did it flood?", report, priceUsd: 29, paymentLink: "https://pay.test/x" });
    for (const part of [report.answer, "Confidence: Medium.", "Flooded area: 0.1235 km² (MNDWI > 0.2)", "NDVI change: n/a",
      "https://img.test/before.png", "https://img.test/after.png", "Sentinel-2 L2A, 2026-11-03", report.limitations,
      HUMAN_REVIEW_NOTE, report.url, "$29", "https://pay.test/x", AI_DISCLOSURE]) {
      expect(e.text).toContain(part);
    }
    expect(e.text.indexOf("before.png")).toBeLessThan(e.text.indexOf("after.png"));
    expect(e.text).not.toContain("Opt out");
  });

  it("offers monitoring of the site in every delivery, unless it is already monitored", () => {
    const e = renderReportDelivery({ question: "Did it flood?", report });
    expect(e.text).toContain(MONITORING_OFFER);
    expect(MONITORING_OFFER).toMatch(/Reply "monitor".*\$49 per site per month/);
    expect(renderReportDelivery({ question: "Did it flood?", report, offerMonitoring: false }).text).not.toContain(MONITORING_OFFER);
  });

  it("omits the review note and price when not applicable", () => {
    const e = renderReportDelivery({ question: "Did it flood?", report: { ...report, human_review_recommended: false } });
    expect(e.text).toContain("Hi there,");
    expect(e.text).not.toContain(HUMAN_REVIEW_NOTE);
    expect(e.text).not.toContain("price");
  });

  it("quote, clarifying question, refusal and supplier request carry the disclosure", () => {
    const emails = [
      renderQuote({ question: "Did it flood?", requestId: "req_1", paymentLink: null, quote: { price_usd: 49, auto_approved: true, line_items: [{ label: "Analysis", amount_usd: 49 }] } }),
      renderClarifyingQuestion({ question: "Check my land", clarifyingQuestion: "Which parcel?" }),
      renderRefusal({ reason: "it asks us to track a person." }),
      renderSupplierQuoteRequest({ providerName: "UP42", product: "Pléiades Neo archive", aoiDescription: "2 km box around 29.76,-95.37", areaKm2: 4, dateWindow: "2026-11-01 to 2026-11-07", orderId: "ord_1" }),
    ];
    for (const e of emails) expect(e.text).toContain(AI_DISCLOSURE);
    expect(emails[0].text).toContain("Total: $49");
    expect(emails[0].text).toContain('reply "yes"');
    expect(emails[3].subject).toContain("ord_1");
    expect(emails[3].text).toContain("4 km²");
  });

  it("a monitoring update carries the change, the earlier report and the disclosure, with no opt-out", () => {
    const e = renderCustomerUpdate({
      customerName: "Pat", question: "Is the vineyard recovering?", update: "NDVI rose from 0.41 to 0.52 since Oct 3 (clear scene Nov 6).",
      reportUrl: "https://terragent.test/r/abc", monitoring: true,
    });
    expect(e.subject).toBe("Monitoring update from Terragent");
    for (const part of ["Hi Pat,", '"Is the vineyard recovering?"', "NDVI rose from 0.41 to 0.52", "Your earlier report: https://terragent.test/r/abc",
      "keep watching", AI_DISCLOSURE]) {
      expect(e.text).toContain(part);
    }
    expect(e.html).toContain('<a href="https://terragent.test/r/abc"');
    expect(e.text).not.toContain("Opt out");
  });

  it("a status update without a report has no report line and no monitoring promise", () => {
    const e = renderCustomerUpdate({ question: "Did it flood?", update: "The latest pass was cloudy; we're waiting for the next clear one." });
    expect(e.subject).toBe("An update on your Terragent request");
    expect(e.text).toContain("Hi there,");
    expect(e.text).toContain("waiting for the next clear one");
    expect(e.text).not.toMatch(/earlier report|keep watching/);
  });
});

describe("ensureCompliance", () => {
  it("appends disclosure and opt-out only when missing, and builds HTML from text", () => {
    const plain = ensureCompliance({ text: "Hello" }, { optOutUrl: OPT_OUT });
    expect(plain.text).toContain(AI_DISCLOSURE);
    expect(plain.text).toContain(OPT_OUT);
    expect(plain.html).toContain(OPT_OUT);

    const already = ensureCompliance({ text: `Hello\n\n${AI_DISCLOSURE}\n${OPT_OUT}` }, { optOutUrl: OPT_OUT });
    expect(already.text.split(AI_DISCLOSURE)).toHaveLength(2);
    expect(already.text.split(OPT_OUT)).toHaveLength(2);
  });
});

describe("seedTemplates", () => {
  let db: Db;
  beforeAll(async () => {
    db = await memoryDb();
  });
  afterAll(() => db.close());

  it("upserts drafts and never touches an approved template", async () => {
    const first = await seedTemplates(db);
    expect(first.map((r) => r.action)).toEqual(["created", "created", "created", "created"]);
    await db.query("UPDATE templates SET status = 'approved', body = 'approved text' WHERE playbook = 'mining'");
    const second = await seedTemplates(db);
    expect(second.find((r) => r.playbook === "mining")?.action).toBe("kept");
    expect(second.find((r) => r.playbook === "disasters")?.action).toBe("updated");
    const rows = await db.query<{ playbook: string; status: string; kind: string; body: string }>("SELECT playbook, status, kind, body FROM templates ORDER BY playbook");
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.playbook === "mining")?.body).toBe("approved text");
    expect(rows.find((r) => r.playbook === "all")?.kind).toBe("followup");
    expect(rows.filter((r) => r.status === "draft")).toHaveLength(3);
  });
});
