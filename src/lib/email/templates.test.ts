import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { seedTemplates, TEMPLATE_SEEDS } from "./template-library";
import {
  AI_DISCLOSURE, ensureCompliance, fillTemplate, HUMAN_REVIEW_NOTE, MONITORING_OFFER, renderClarifyingQuestion, renderFollowup, renderOutreach,
  optionPriceText, quoteAcceptUrl, renderCustomerUpdate, renderQuote, renderRefusal, renderReportDelivery, renderSupplierQuoteRequest,
  TemplateError, type QuoteOptionForEmail, type ReportForEmail,
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

  it("puts the full report link right under the greeting, names the accepted option and links the status page", () => {
    const e = renderReportDelivery({
      customerName: "Pat", question: "Did it flood?", report, priceUsd: 85,
      acceptedOption: { option_id: "B", label: "Sharp archive image", accepted_at: "2026-11-08T10:00:00Z" },
      statusUrl: "https://terragent.test/request/req_1",
    });
    const lines = e.text.split("\n\n");
    expect(lines[0]).toBe("Hi Pat,");
    expect(lines[1]).toContain(report.url);
    expect(e.text.indexOf(report.url)).toBeLessThan(e.text.indexOf(report.answer));
    expect(e.html.indexOf(report.url)).toBeLessThan(e.html.indexOf("Did it flood?"));
    expect(e.text).toContain("Price: $85, option B (Sharp archive image) as you accepted on 8 Nov 2026.");
    expect(e.text).toContain("https://terragent.test/request/req_1");
  });

  it("shows a fraction measurement as a percentage", () => {
    const m = [{ metric: "Clear fraction of the AOI", value: 1, unit: "fraction", note: null }, { metric: "Share burned", value: 0.4237, unit: "fraction", note: null }];
    const e = renderReportDelivery({ question: "Did it burn?", report: { ...report, measurements: m } });
    expect(e.text).toContain("- Clear fraction of the AOI: 100%");
    expect(e.text).toContain("- Share burned: 42.4%");
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

describe("quote with options (pricing v2)", () => {
  const free: QuoteOptionForEmail = {
    option_id: "A", label: "Free-data check", answers: "Whether floodwater reached the building.", kind: "free_data",
    data: [{ data_type: "optical", resolution_m: 10, epochs: 2, needs_supplier_quote: false }],
    price_usd: 29, price_range_usd: null, delivery_time: "within 2 hours",
  };
  const archive: QuoteOptionForEmail = {
    option_id: "B", label: "Sharp archive image", answers: "Whether individual roof sections are damaged", kind: "archive",
    data: [{ data_type: "optical", resolution_m: 0.5, epochs: 1, needs_supplier_quote: true }],
    price_usd: null, price_range_usd: [180, 260], delivery_time: "1–2 days",
  };
  const tasking: QuoteOptionForEmail = {
    option_id: "C", label: "New capture", answers: "What the roof looks like this week", kind: "tasking",
    data: [{ data_type: "optical", resolution_m: 0.3, epochs: 1 }], price_usd: 650, price_range_usd: null, delivery_time: "3–7 days",
  };
  const quote = { options: [free, archive, tasking], recommended_option_id: "B", valid_until: "2026-11-14T21:00:00Z", accept_token: "TokTokTokTokTokTok1234" };
  const render = (q: Parameters<typeof renderQuote>[0]["quote"] = quote, extra: Partial<Parameters<typeof renderQuote>[0]> = {}) =>
    renderQuote({ customerName: "Pat", question: "Did the storm damage our roof?", requestId: "req_q1", quote: q, ...extra });

  afterEach(() => vi.unstubAllEnvs());

  it("links the request's status page when given one", () => {
    expect(render(quote, { statusUrl: "https://terragent.test/request/req_q1" }).text).toContain("https://terragent.test/request/req_q1");
    expect(render().text).not.toContain("/request/");
  });

  it("lists every option with what it answers, detail, delivery and price or range, the recommended one marked", () => {
    const e = render();
    expect(e.subject).toBe("Your Terragent quote (req_q1)");
    expect(e.text).toContain(
      "- Option A: Free-data check. Answers: Whether floodwater reached the building. Free public satellite data (the price is for our analysis and verified report), 10 m detail, 2 dates. " +
        "Delivery: within 2 hours. Price: $29.",
    );
    expect(e.text).toContain("- Option B (recommended): Sharp archive image. Answers: Whether individual roof sections are damaged.");
    expect(e.text).toContain("Archive imagery we buy for you, 0.5 m detail, 1 date. Delivery: 1–2 days. Price: $180 to $260 (estimate");
    expect(e.text).toContain("- Option C: New capture.");
    expect(e.text).toContain("0.3 m detail");
    expect(e.text).toContain("Price: $650.");
    expect(e.text.match(/\(recommended\)/g)).toHaveLength(1);
    expect(e.html).toMatch(/<ul[^>]*><li>Option A: Free-data check\./);
  });

  it("says how to accept (reply yes / a letter, or the link), that paid data is bought only after acceptance, and validity", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
    const e = render();
    expect(e.text).toContain('reply "yes" for option B, or reply with the letter of the option you want (A, B or C).');
    expect(e.text).toContain("You can also choose online: https://terragent.test/quote/TokTokTokTokTokTok1234");
    expect(e.html).toContain('<a href="https://terragent.test/quote/TokTokTokTokTokTok1234"');
    expect(e.text).toContain("That check is free. Nothing else happens, and nothing is bought or charged, until you choose an option.");
    expect(e.text).toContain("We buy paid imagery only after you accept an option that needs it.");
    expect(e.text).toContain("This quote is valid until 14 Nov 2026. Reference: req_q1");
    expect(e.text).toContain(AI_DISCLOSURE);
    expect(e.text).not.toMatch(/margin|analysis_cost|risk|unit_price|Opt out/i);
  });

  it("prefers an explicit accept link, defaults the recommendation to the first option, and drops paid-data wording for free-only quotes", () => {
    const e = render({ options: [free, { ...free, option_id: "B", label: "Free check, 6 dates", data: [{ data_type: "optical", resolution_m: 10, epochs: 6 }], price_usd: 39 }] },
      { acceptUrl: "https://x.test/quote/abc" });
    expect(e.text).toContain("- Option A (recommended): Free-data check.");
    expect(e.text).toContain('reply "yes" for option A, or reply with the letter of the option you want (A or B).');
    expect(e.text).toContain("You can also choose online: https://x.test/quote/abc");
    expect(e.text).toContain("6 dates");
    expect(e.text).not.toContain("paid imagery");
    expect(e.text).not.toContain("valid until");
  });

  it("a single option needs no letter and no recommended mark; no token means no link", () => {
    const e = render({ options: [free] });
    expect(e.text).toContain('To go ahead, reply "yes" to this email.');
    expect(e.text).toContain("priced the work below");
    expect(e.text).not.toContain("(recommended)");
    expect(e.text).not.toContain("choose online");
  });

  it("formats prices and builds the accept URL from the public base", () => {
    vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test/");
    expect(quoteAcceptUrl("abcDEF1234567890")).toBe("https://terragent.test/quote/abcDEF1234567890");
    expect(optionPriceText({ price_usd: 1250, price_range_usd: null })).toBe("$1250");
    expect(optionPriceText({ price_usd: null, price_range_usd: [900, 1400] })).toMatch(/^\$900 to \$1400 \(estimate/);
    expect(optionPriceText({ price_usd: null, price_range_usd: null })).toBe("on request");
  });

  it("a quote without options keeps the single-price email", () => {
    const e = renderQuote({ question: "Did it flood?", requestId: "req_1", quote: { price_usd: 49, line_items: [{ label: "Analysis", amount_usd: 49 }], options: [] } });
    expect(e.text).toContain("Total: $49");
    expect(e.text).not.toContain("Option A");
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
