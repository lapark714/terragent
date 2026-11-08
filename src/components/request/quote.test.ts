import { describe, expect, it } from "vitest";
import type { PublicQuote, PublicQuoteOption } from "@/lib/dashboard/public";
import {
  acceptLabel, acceptToken, afterChoiceText, chosenText, dataText, emailHint, introText, isEstimate, listText, NETWORK_ERROR, orderOptions,
  priceText, quotePath, quoteState, readAcceptResponse, recommendedId, resolutionText, SOURCE_TEXT, validUntilText,
} from "./quote";

const option = (over: Partial<PublicQuoteOption>): PublicQuoteOption => ({
  option_id: "A", label: "Free satellite check", answers: "Clearing larger than half a hectare.", kind: "free_data", resolution_m: 10,
  data_types: ["optical"], epochs: 2, price_usd: 29, price_range_usd: null, needs_supplier_quote: false, delivery_time: "About an hour",
  confidence: "medium", recommended: false, ...over,
});
const A = option({});
const B = option({ option_id: "B", label: "Sharp archive image", kind: "archive", resolution_m: 0.5, epochs: 1, price_usd: 85, recommended: true, confidence: "high" });
const C = option({ option_id: "C", label: "New capture", kind: "tasking", resolution_m: 0.3, price_usd: null, price_range_usd: [450, 700], needs_supplier_quote: true });

const TOKEN = "Kq7xT2mPz9RwB4nL8vYc3HdF";
const quote = (over: Partial<PublicQuote> = {}): PublicQuote => ({
  id: "qte_1", status: "sent", options: [A, B, C], recommended_option_id: "B", accepted_option_id: null, accepted_at: null,
  valid_until: "2026-11-15T09:00:00Z", closed_reason: null, accept_url: `https://terragent.example/quote/${TOKEN}`, ...over,
});

describe("prices", () => {
  it("shows a fixed price, or a range marked as an estimate", () => {
    expect(priceText(A)).toBe("$29");
    expect(priceText(B)).toBe("$85");
    expect(priceText(C)).toBe("$450–$700");
    expect(priceText(option({ price_usd: 1200 }))).toBe("$1,200");
    expect(priceText(option({ price_usd: 29.5 }))).toBe("$29.50");
    expect(priceText(option({ price_usd: null, price_range_usd: [180, 180] }))).toBe("$180");
    expect(isEstimate(A)).toBe(false);
    expect(isEstimate(C)).toBe(true);
  });

  it("labels each Accept button with its option and price", () => {
    expect(acceptLabel(A)).toBe("Accept option A · $29");
    expect(acceptLabel(C)).toBe("Accept option C · $450–$700");
  });
});

describe("option details", () => {
  it("writes resolution in metres, or centimetres below a metre", () => {
    expect(resolutionText(10)).toBe("10 m");
    expect(resolutionText(1.5)).toBe("1.5 m");
    expect(resolutionText(0.5)).toBe("50 cm");
    expect(resolutionText(0.3)).toBe("30 cm");
    expect(resolutionText(null)).toBeNull();
    expect(resolutionText(0)).toBeNull();
  });

  it("lists data types and dates when known", () => {
    expect(dataText(A)).toBe("Optical, 2 dates");
    expect(dataText(option({ data_types: ["optical", "radar"], epochs: 1 }))).toBe("Optical and radar, 1 date");
    expect(dataText(option({ data_types: [], epochs: 3 }))).toBe("3 dates");
    expect(dataText(option({ data_types: [], epochs: null }))).toBeNull();
    expect(listText(["A", "B", "C"])).toBe("A, B or C");
    expect(listText(["A"])).toBe("A");
  });
});

describe("ordering", () => {
  it("puts the recommended option first, then A, B, C, without touching the input", () => {
    const input = [C, A, B];
    expect(orderOptions(input, "B").map((o) => o.option_id)).toEqual(["B", "A", "C"]);
    expect(input.map((o) => o.option_id)).toEqual(["C", "A", "B"]);
    // The quote's recommended_option_id counts even if no option carries the flag.
    const unflagged = [A, { ...B, recommended: false }, C];
    expect(orderOptions(unflagged, "C").map((o) => o.option_id)).toEqual(["C", "A", "B"]);
    expect(orderOptions(unflagged, null).map((o) => o.option_id)).toEqual(["A", "B", "C"]);
  });

  it("finds the recommended option from the quote or the flag", () => {
    expect(recommendedId(quote())).toBe("B");
    expect(recommendedId(quote({ recommended_option_id: null }))).toBe("B");
    expect(recommendedId(quote({ recommended_option_id: null, options: [A, C] }))).toBeNull();
  });
});

describe("accept token", () => {
  it("is the last path segment of accept_url", () => {
    expect(acceptToken(`https://terragent.example/quote/${TOKEN}`)).toBe(TOKEN);
    expect(acceptToken(`https://terragent.example/quote/${TOKEN}/`)).toBe(TOKEN);
    expect(acceptToken(`https://terragent.example/quote/${TOKEN}?utm=mail#top`)).toBe(TOKEN);
    expect(acceptToken(`/quote/${TOKEN}`)).toBe(TOKEN);
    expect(acceptToken("https://terragent.example/quote/abc_DEF-1234567890xyz")).toBe("abc_DEF-1234567890xyz");
  });

  it("refuses anything that isn't a token", () => {
    for (const bad of [null, undefined, "", "https://terragent.example/quote/", "https://terragent.example/quote/short", "https://terragent.example/quote/has%20space%20in%20it%20yes", "not a url %E0%A4%A"]) {
      expect(acceptToken(bad), String(bad)).toBeNull();
    }
  });

  it("links to the quote page on this site", () => {
    expect(quotePath(TOKEN)).toBe(`/quote/${TOKEN}`);
  });
});

describe("state and small print", () => {
  it("is open with a token, accepted once chosen, closed when expired, replaced or closed", () => {
    expect(quoteState(quote())).toEqual({ kind: "open", token: TOKEN });
    expect(quoteState(quote({ accept_url: null }))).toEqual({ kind: "open", token: null });
    expect(quoteState(quote({ accepted_option_id: "B", accepted_at: "2026-11-08T10:00:00Z", closed_reason: "accepted", accept_url: null })))
      .toEqual({ kind: "accepted", optionId: "B", at: "2026-11-08T10:00:00Z" });
    for (const reason of ["expired", "superseded", "closed"] as const) {
      expect(quoteState(quote({ closed_reason: reason, accept_url: null }))).toEqual({ kind: "closed", reason });
    }
  });

  it("explains how to accept by email and until when", () => {
    expect(emailHint(["A", "B", "C"], "B")).toBe("Prefer email? Reply “yes” to the quote email for option B, or name A, B or C.");
    expect(emailHint(["A", "B"], null)).toBe("Prefer email? Reply “yes” to the quote email for option A, or name A or B.");
    expect(emailHint(["A"], "A")).toBe("Prefer email? Reply “yes” to the quote email.");
    // No Accept buttons (no usable accept link): email is the only way, so no "Prefer email?".
    expect(emailHint(["A", "B", "C"], "B", false)).toBe("Reply “yes” to the quote email for option B, or name A, B or C.");
    expect(emailHint(["A"], "A", false)).toBe("Reply “yes” to the quote email.");
    expect(validUntilText("2026-11-15T09:00:00Z")).toBe("Valid until Nov 15, 2026.");
    expect(validUntilText(null)).toBeNull();
  });

  it("opens with the buttons, or with the email reply when there are none", () => {
    expect(introText(true)).toMatch(/Choose an option to go ahead/);
    expect(introText(false)).toMatch(/reply to the quote email with the option you want/);
    expect(introText(false)).not.toMatch(/Choose an option/);
    for (const buttons of [true, false]) expect(introText(buttons)).toMatch(/nothing is bought or charged until you do/);
  });

  it("says free data still costs the analysis, and paid data is bought only after acceptance", () => {
    expect(SOURCE_TEXT.free_data).toMatch(/^Free public satellite data; you pay for the analysis/);
    expect(SOURCE_TEXT.archive).toMatch(/after you accept/);
    expect(SOURCE_TEXT.tasking).toMatch(/after you accept/);
  });

  it("says which option was chosen, and what happens next", () => {
    expect(chosenText(quote(), "B", "2026-11-08T10:00:00Z")).toBe("You chose option B (Sharp archive image) on Nov 8, 2026");
    expect(chosenText(quote(), "A", null)).toBe("You chose option A (Free satellite check)");
    expect(chosenText(quote({ options: [] }), "C", null)).toBe("You chose option C");
    expect(afterChoiceText("archive")).toMatch(/founder buys the imagery by hand/);
    expect(afterChoiceText("free_data")).toMatch(/start on the analysis now/);
  });
});

describe("accept responses", () => {
  it("counts 200 as success, a repeat of the same option included", () => {
    expect(readAcceptResponse(200, { request_id: "req_1", status: "analyzing", accepted_option_id: "A", already_accepted: false }, "A"))
      .toEqual({ ok: true, optionId: "A", already: false });
    expect(readAcceptResponse(200, { accepted_option_id: "B", already_accepted: true }, "B")).toEqual({ ok: true, optionId: "B", already: true });
    expect(readAcceptResponse(200, null, "C")).toEqual({ ok: true, optionId: "C", already: false });
  });

  it("shows the API's own message on errors, with a fallback when there is none", () => {
    const taken = readAcceptResponse(409, { error: "already_accepted", accepted_option_id: "B", message: "This quote was already accepted with another option." }, "A");
    expect(taken).toEqual({ ok: false, message: "This quote was already accepted with another option.", acceptedOptionId: "B" });
    expect(readAcceptResponse(410, { error: "expired", message: "This quote has expired." }, "A")).toMatchObject({ ok: false, message: "This quote has expired." });
    expect(readAcceptResponse(429, { error: "rate_limited" }, "A")).toMatchObject({ ok: false, message: expect.stringMatching(/Too many tries/) });
    expect(readAcceptResponse(502, "<html>Bad gateway</html>", "A")).toMatchObject({ ok: false, message: expect.stringMatching(/couldn't record that/) });
    expect(NETWORK_ERROR).toMatch(/reply to the quote email/);
  });
});
