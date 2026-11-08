import { describe, expect, it } from "vitest";
import type { PublicQuote } from "@/lib/dashboard/public";
import { REQUEST_STATUSES, TERMINAL_STATUSES, type RequestStatus } from "@/lib/domain";
import { STATUS_LABEL } from "@/components/format";
import {
  agentIsWorking, customerEvents, headingOf, showsChosenOption, showsQuoteChoice, STEP_OF, STEPS, timelineActor, trackOf,
} from "./progress";

/** Pricing v2 track: the investigation ends in a quote, nothing runs until the customer chooses, then imagery → analysis → verification → report. */
const EXPECTED: Record<RequestStatus, { step: number; outcome: ReturnType<typeof trackOf>["outcome"]; label: string | null }> = {
  received: { step: 0, outcome: "active", label: "Received" },
  screening: { step: 1, outcome: "active", label: "Checked" },
  clarifying: { step: 1, outcome: "active", label: "Checked" },
  planning: { step: 2, outcome: "active", label: "Priced" },
  acquiring: { step: 2, outcome: "active", label: "Priced" },
  pricing: { step: 2, outcome: "active", label: "Priced" },
  quoted: { step: 3, outcome: "active", label: "Your choice" },
  awaiting_approval: { step: 4, outcome: "active", label: "Imagery" },
  fetching: { step: 4, outcome: "active", label: "Imagery" },
  analyzing: { step: 5, outcome: "active", label: "Analysis" },
  verifying: { step: 6, outcome: "active", label: "Verified" },
  revising: { step: 6, outcome: "active", label: "Verified" },
  delivering: { step: 7, outcome: "active", label: "Delivered" },
  delivered: { step: 8, outcome: "delivered", label: null },
  refused: { step: 1, outcome: "refused", label: "Checked" },
  failed: { step: -1, outcome: "stopped", label: null },
  cancelled: { step: -1, outcome: "stopped", label: null },
};

describe("step track", () => {
  it("has the eight pricing v2 steps", () => {
    expect(STEPS).toEqual(["Received", "Checked", "Priced", "Your choice", "Imagery", "Analysis", "Verified", "Delivered"]);
  });

  it.each(REQUEST_STATUSES)("maps %s to its step", (status) => {
    const want = EXPECTED[status];
    const got = trackOf({ status });
    expect(got).toEqual({ step: want.step, outcome: want.outcome });
    expect(got.step >= 0 && got.step < STEPS.length ? STEPS[got.step] : null).toBe(want.label);
  });

  it("covers every status, and delivered is past the last step", () => {
    expect(Object.keys(STEP_OF).sort()).toEqual([...REQUEST_STATUSES].sort());
    expect(STEP_OF.delivered).toBe(STEPS.length);
    // Every live status sits on a real step; only failed/cancelled have none.
    for (const s of REQUEST_STATUSES) {
      if (s === "failed" || s === "cancelled") expect(STEP_OF[s]).toBe(-1);
      else if (s !== "delivered") expect(STEP_OF[s]).toBeGreaterThanOrEqual(0);
    }
  });

  it("never moves backwards along the happy path", () => {
    const path: RequestStatus[] = ["received", "screening", "planning", "acquiring", "pricing", "quoted", "awaiting_approval", "fetching", "analyzing", "verifying", "delivering", "delivered"];
    const steps = path.map((s) => STEP_OF[s]);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });
});

const quote = (over: Partial<PublicQuote> = {}): PublicQuote => ({
  id: "qte_1", status: "sent", options: [], recommended_option_id: "A", accepted_option_id: null, accepted_at: null,
  valid_until: "2026-11-15T00:00:00Z", closed_reason: null, accept_url: "https://terragent.example/quote/abcdefghijklmnopqrstuvwx", ...over,
});
const view = (status: RequestStatus, q: PublicQuote | null) => ({ status, terminal: TERMINAL_STATUSES.has(status), quote: q });
const accepted = quote({ accepted_option_id: "B", accepted_at: "2026-11-08T10:00:00Z", closed_reason: "accepted", accept_url: null });

describe("what the page shows around a quote", () => {
  it("offers the choice while quoted, or wherever an accept link is open and nothing is chosen", () => {
    expect(showsQuoteChoice(view("quoted", quote()))).toBe(true);
    expect(showsQuoteChoice(view("pricing", quote()))).toBe(true);
    expect(showsQuoteChoice(view("quoted", quote({ closed_reason: "expired", accept_url: null })))).toBe(true); // says it expired
    expect(showsQuoteChoice(view("quoted", accepted))).toBe(true); // accepted, status not moved yet: "You chose option B"
    expect(showsQuoteChoice(view("analyzing", accepted))).toBe(false);
    expect(showsQuoteChoice(view("quoted", null))).toBe(false); // pricing v1 quote: the plain "reply to accept" text
    expect(showsQuoteChoice(view("cancelled", quote({ closed_reason: "closed", accept_url: null })))).toBe(false);
  });

  it("shows the chosen option once accepted, until delivered", () => {
    for (const s of ["awaiting_approval", "fetching", "analyzing", "verifying", "revising", "delivering", "failed"] as const) {
      expect(showsChosenOption(view(s, accepted)), s).toBe(true);
    }
    expect(showsChosenOption(view("delivered", accepted))).toBe(false);
    expect(showsChosenOption(view("quoted", accepted))).toBe(false); // QuoteChoice says it instead
    expect(showsChosenOption(view("analyzing", quote()))).toBe(false);
    expect(showsChosenOption(view("analyzing", null))).toBe(false);
  });

  it("hides 'agent is on it' while the customer chooses or a founder buys the data", () => {
    expect(agentIsWorking(view("quoted", quote()))).toBe(false);
    expect(agentIsWorking(view("pricing", quote()))).toBe(false);
    expect(agentIsWorking(view("awaiting_approval", accepted))).toBe(false);
    expect(agentIsWorking(view("pricing", null))).toBe(true);
    expect(agentIsWorking(view("analyzing", accepted))).toBe(true);
    expect(agentIsWorking(view("delivered", accepted))).toBe(false);
  });
});

describe("the status heading", () => {
  it("is the status label, except while the quote shown can no longer be accepted", () => {
    expect(headingOf(view("quoted", quote()))).toBe("Your quote is ready");
    expect(headingOf(view("quoted", quote({ closed_reason: "expired", accept_url: null })))).toBe("Your quote has expired");
    expect(headingOf(view("quoted", quote({ closed_reason: "superseded", accept_url: null })))).toBe("Replaced by a newer quote");
    expect(headingOf(view("quoted", quote({ closed_reason: "closed", accept_url: null })))).toBe("This quote is closed");
    expect(headingOf(view("quoted", accepted))).toBe("Your quote is ready"); // accepted, status not moved yet
    expect(headingOf(view("quoted", null))).toBe("Your quote is ready"); // pricing v1
    // Once the request is closed, the request's own status speaks (the quote block isn't shown).
    expect(headingOf(view("cancelled", quote({ closed_reason: "closed", accept_url: null })))).toBe("Cancelled");
  });

  it("falls back to STATUS_LABEL for every status without a quote", () => {
    for (const s of REQUEST_STATUSES) expect(headingOf(view(s, null))).toBe(STATUS_LABEL[s]);
  });
});

describe("the customer's timeline", () => {
  const ev = (type: string, actor = "comms-customer") => ({ type, actor, at: "2026-11-08T10:00:00Z" });

  it("leaves out internal bookkeeping (revenue.*) and keeps the rest in order", () => {
    const events = [ev("quote.sent"), ev("quote.accepted", "customer (link)"), ev("revenue.committed", "customer (link)"), ev("revenue.stated_willingness"), ev("handoff", "customer (link)")];
    expect(customerEvents(events).map((e) => e.type)).toEqual(["quote.sent", "quote.accepted", "handoff"]);
    expect(events).toHaveLength(5); // input untouched
  });

  it("shows the customer's own actions as You, everyone else as before", () => {
    expect(timelineActor("customer (link)")).toBe("You");
    expect(timelineActor("customer")).toBe("You");
    expect(timelineActor("customer (email)")).toBe("You");
    expect(timelineActor("comms-customer")).toBe("Customer comms");
    expect(timelineActor("human:Laurence")).toBe("Laurence");
    expect(timelineActor("system")).toBe("System");
    expect(timelineActor(null)).toBe("Unassigned");
  });
});
