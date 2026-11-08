import { describe, expect, it } from "vitest";
import type { Approvals, Board, Decisions, Money, RequestMoney } from "@/lib/dashboard/types";
import { dataSources, dealStage, deals, dealTotals, median, ourPrices, products, sourceName } from "./model";

const req = (over: Partial<RequestMoney>): RequestMoney => ({ id: "req_a", playbook: "inbound", status: "pricing", sample: false, cost: 1, price: null, paid: 0, ...over });

const money = (perRequest: RequestMoney[]): Money => ({
  spend: { total: 0, naive: 0, monid: 0, data: 0, other: 0, naiveSource: "table" },
  naiveBalanceUsd: null,
  revenue: { paid: 0, committed: 0, stated: 0, paidCount: 0, committedCount: 0, statedCount: 0 },
  byAgent: [],
  perRequest,
});

const board: Board = {
  naive: { state: "offline" },
  requests: [
    { id: "req_a", playbook: "inbound", status: "quoted", owner: "pricing", source: "portal", sample: false, question: "Flooded?", location: "Fresno", customer: "a***@farm.example", updatedAt: "2026-11-07T10:00:00Z" },
  ],
};

describe("dealStage", () => {
  const none = new Set<string>();
  it("puts payment first, then losses, then founder holds", () => {
    expect(dealStage(req({ paid: 29, price: 29, status: "delivered" }), none)).toBe("paid");
    expect(dealStage(req({ status: "failed", price: 29 }), none)).toBe("lost");
    expect(dealStage(req({ id: "req_h", price: 174, status: "awaiting_approval" }), new Set(["req_h"]))).toBe("founder");
  });
  it("separates unpriced, quoted and delivered-but-unpaid", () => {
    expect(dealStage(req({}), none)).toBe("unpriced");
    expect(dealStage(req({ price: 39, status: "quoted" }), none)).toBe("quoted");
    expect(dealStage(req({ price: 29, status: "delivered" }), none)).toBe("owed");
  });
});

describe("deals", () => {
  it("skips free samples, joins the board and sorts by stage", () => {
    const list = deals(
      money([req({ id: "req_s", sample: true }), req({ id: "req_p", paid: 29, price: 29, status: "delivered" }), req({ id: "req_a", price: 39, status: "quoted", cost: 0.5 })]),
      board,
      null,
    );
    expect(list.map((d) => d.id)).toEqual(["req_a", "req_p"]);
    expect(list[0]).toMatchObject({ customer: "a***@farm.example", location: "Fresno", margin: 38.5 });
  });
  it("marks quotes held for a founder", () => {
    const approvals = { quotes: [{ request: "req_h" }] } as unknown as Approvals;
    expect(deals(money([req({ id: "req_h", price: 174, status: "awaiting_approval" })]), null, approvals)[0].stage).toBe("founder");
  });
});

describe("dealTotals", () => {
  it("counts open value from quotes, holds and unpaid deliveries, and paid from payments", () => {
    const t = dealTotals(
      deals(money([req({ id: "1", price: 39, status: "quoted" }), req({ id: "2", price: 29, status: "delivered" }), req({ id: "3", price: 29, paid: 29, status: "delivered" })]), null, null),
    );
    expect(t.open).toBe(68);
    expect(t.owed).toBe(29);
    expect(t.byStage.paid).toEqual({ n: 1, value: 29 });
  });
});

describe("products and prices", () => {
  it("lists delivered work only, samples included", () => {
    const p = products(money([req({ id: "1", status: "delivered", sample: true }), req({ id: "2", status: "analyzing" })]), null);
    expect(p.map((x) => x.id)).toEqual(["1"]);
  });
  it("summarises quoted prices without samples", () => {
    expect(ourPrices(money([req({ price: 29 }), req({ price: 39 }), req({ price: 174 }), req({ price: 5, sample: true })]))).toEqual({ n: 3, low: 29, median: 39, high: 174 });
    expect(median([])).toBeNull();
    expect(median([1, 3])).toBe(2);
  });
});

describe("dataSources", () => {
  it("names sources from the agent's choice text", () => {
    expect(sourceName("Sentinel-2 L2A, 2026-09-20 (clear) vs 2026-05-05")).toBe("Sentinel-2 L2A");
    expect(sourceName("Sentinel-2 L2A searched first: clear pass on Nov 5, but 10 m")).toBe("Sentinel-2 L2A");
    expect(sourceName("Landsat 9 C2 L2")).toBe("Landsat 9 C2 L2");
  });
  it("counts sources used and paid options passed over", () => {
    const row = (kind: string, choice: string, alternatives: { option: string; cost_usd?: number | null; why_not: string }[], at: string) =>
      ({ id: at, request: "r", playbook: "inbound", kind, choice, reasoning: "", alternatives, agent: "acquisition", at }) as Decisions["rows"][number];
    const d: Decisions = {
      rows: [
        row("source_selection", "Sentinel-2 L2A, a", [], "2026-11-07T01:00:00Z"),
        row("source_selection", "Sentinel-2 L2A, b", [], "2026-11-07T02:00:00Z"),
        row("free_vs_paid", "free", [{ option: "SkySat", cost_usd: 160, why_not: "" }, { option: "Landsat", cost_usd: 0, why_not: "" }], "2026-11-07T03:00:00Z"),
        row("free_vs_paid", "free", [{ option: "SkySat", cost_usd: 180, why_not: "" }], "2026-11-07T04:00:00Z"),
      ],
      freeVsPaid: [{ choice: "free", n: 2 }, { choice: "paid", n: 1 }],
    };
    const s = dataSources(d);
    expect(s.used).toEqual([{ name: "Sentinel-2 L2A", requests: 2, last: "2026-11-07T02:00:00Z" }]);
    expect(s.declined).toEqual([{ option: "SkySat", times: 2, low: 160, high: 180 }]);
    expect([s.free, s.paid]).toEqual([2, 1]);
  });
});
