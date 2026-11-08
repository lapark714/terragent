import { describe, expect, it } from "vitest";
import type { Board, Decisions, Money, RequestMoney } from "@/lib/dashboard/types";
import { byStage, costs, dataSources, dealStage, deals, median, openValue, products, requestSources, sourceName } from "./model";

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

const row = (kind: string, choice: string, request: string | null, alternatives: { option: string; cost_usd?: number | null; why_not: string }[] = [], at = "2026-11-07T01:00:00Z") =>
  ({ id: `${kind}${request}${at}${choice}`, request, playbook: "inbound", kind, choice, reasoning: "", alternatives, agent: "acquisition", at }) as Decisions["rows"][number];

describe("dealStage", () => {
  it("puts each request status in one of the four sections, and drops lost ones", () => {
    expect(dealStage("screening")).toBe("outreach");
    expect(dealStage("pricing")).toBe("outreach");
    expect(dealStage("quoted")).toBe("negotiation");
    expect(dealStage("awaiting_approval")).toBe("negotiation");
    expect(dealStage("analyzing")).toBe("fulfillment");
    expect(dealStage("delivered")).toBe("completed");
    expect(dealStage("refused")).toBeNull();
  });
});

describe("deals", () => {
  it("skips free samples and lost requests, joins the board and the decision log", () => {
    const decisions: Decisions = { rows: [row("source_selection", "Sentinel-2 L2A, a", "req_d"), row("free_vs_paid", "free", "req_d")], freeVsPaid: [] };
    const list = deals(
      money([req({ id: "req_s", sample: true }), req({ id: "req_x", status: "failed" }), req({ id: "req_d", status: "delivered", price: 29, paid: 29 }), req({ id: "req_a", price: 39, status: "quoted", cost: 0.5 })]),
      board,
      decisions,
    );
    expect(list.map((d) => d.id)).toEqual(["req_a", "req_d"]);
    expect(list[0]).toMatchObject({ stage: "negotiation", customer: "a***@farm.example", profit: 38.5 });
    expect(list[1]).toMatchObject({ stage: "completed", sources: ["Sentinel-2 L2A"], paidData: false });
    expect(byStage(list).completed.map((d) => d.id)).toEqual(["req_d"]);
  });
  it("counts open and owed money", () => {
    const v = openValue(deals(money([req({ id: "1", price: 39, status: "quoted" }), req({ id: "2", price: 29, status: "delivered" }), req({ id: "3", price: 29, paid: 29, status: "delivered" })]), null, null));
    expect(v).toEqual({ open: 68, owed: 29, owedCount: 1 });
  });
});

describe("requestSources", () => {
  it("collects each request's sources and paid-data call", () => {
    const m = requestSources({ rows: [row("source_selection", "Landsat 9 C2 L2", "r1"), row("source_selection", "Sentinel-2 L2A, x", "r1"), row("free_vs_paid", "paid", "r1"), row("pricing", "$29", "r2")], freeVsPaid: [] });
    expect(m.get("r1")).toEqual({ sources: ["Landsat 9 C2 L2", "Sentinel-2 L2A"], paidData: true });
    expect(m.get("r2")).toEqual({ sources: [], paidData: null });
  });
});

describe("products and prices", () => {
  it("lists delivered work only, samples included", () => {
    const decisions: Decisions = { rows: [row("source_selection", "Landsat 9 C2 L2, x", "1")], freeVsPaid: [] };
    const p = products(money([req({ id: "1", status: "delivered", sample: true }), req({ id: "2", status: "analyzing" })]), null, decisions);
    expect(p.map((x) => [x.id, x.sources])).toEqual([["1", ["Landsat 9 C2 L2"]]]);
  });
  it("breaks costs into shares and finds the typical report cost", () => {
    const m = money([req({ id: "a", status: "delivered", cost: 1, price: 29 }), req({ id: "b", status: "delivered", cost: 3, price: 39 }), req({ id: "c", cost: 9 })]);
    m.spend = { ...m.spend, naive: 3, monid: 1 };
    m.byAgent = [{ agent: "planner", usd: 1 }, { agent: "verifier", usd: 3 }];
    const c = costs(m);
    expect(c.services.map((s) => s.share)).toEqual([0.75, 0.25, 0, 0]);
    expect(c.agents.map((a) => a.label)).toEqual(["verifier", "planner"]);
    expect(c.perReport).toEqual({ median: 2, low: 1, high: 3, n: 2 });
    expect(c.markup).toBe(21);
    expect(c.priciest[0].id).toBe("c");
    expect(median([])).toBeNull();
    expect(median([1, 3])).toBe(2);
  });
});

describe("dataSources", () => {
  it("names sources from the agent's choice text", () => {
    expect(sourceName("Sentinel-2 L2A, 2026-09-20 (clear) vs 2026-05-05")).toBe("Sentinel-2 L2A");
    expect(sourceName("Sentinel-2 L2A searched first: clear pass on Nov 5, but 10 m")).toBe("Sentinel-2 L2A");
  });
  it("counts sources used and paid options passed over", () => {
    const d: Decisions = {
      rows: [
        row("source_selection", "Sentinel-2 L2A, a", "r", [], "2026-11-07T01:00:00Z"),
        row("source_selection", "Sentinel-2 L2A, b", "r", [], "2026-11-07T02:00:00Z"),
        row("free_vs_paid", "free", "r", [{ option: "SkySat", cost_usd: 160, why_not: "" }, { option: "Landsat", cost_usd: 0, why_not: "" }], "2026-11-07T03:00:00Z"),
        row("free_vs_paid", "free", "r", [{ option: "SkySat", cost_usd: 180, why_not: "" }], "2026-11-07T04:00:00Z"),
      ],
      freeVsPaid: [{ choice: "free", n: 2 }, { choice: "paid", n: 1 }],
    };
    const s = dataSources(d);
    expect(s.used).toEqual([{ name: "Sentinel-2 L2A", requests: 2, last: "2026-11-07T02:00:00Z", playbooks: ["inbound"] }]);
    expect(s.declined).toEqual([{ option: "SkySat", times: 2, low: 160, high: 180 }]);
  });
});
