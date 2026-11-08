import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureJson } from "./__fixtures__/fetch-mock";

const monidRun = vi.fn();
vi.mock("../monid/client", () => ({ monidRun }));
const { fetchNews } = await import("./news");

describe("news (Monid akta, paid)", () => {
  afterEach(() => monidRun.mockReset());

  it("does nothing unless paid calls are explicitly allowed", async () => {
    const { signals, warnings } = await fetchNews({});
    expect(signals).toEqual([]);
    expect(warnings[0]).toMatch(/paid feed/);
    expect(monidRun).not.toHaveBeenCalled();
  });

  it("runs akta /v1/news through monidRun with a capped limit and maps articles", async () => {
    monidRun.mockResolvedValue({ status: "COMPLETED", output: fixtureJson("news-akta.json"), cost_usd: 0.006, run_id: "run_1" });
    const { signals, warnings } = await fetchNews({ allowPaid: true, limit: 50, since: new Date("2026-11-01T00:00:00Z"), agent: "sourcing" });
    expect(warnings).toEqual([]);
    expect(monidRun).toHaveBeenCalledWith(expect.objectContaining({
      provider: "akta",
      endpoint: "/v1/news",
      agent: "sourcing",
      input: { queryParams: expect.objectContaining({ limit: 10, start_date: "2026-11-01", group_articles: true }) },
    }));
    expect(signals).toHaveLength(2);
    expect(signals[0]).toMatchObject({ playbook: "mining", feed: "news", severity: null, lat: null });
    expect(signals[0].external_id).toMatch(/^group:/);
    expect(signals[0].raw.companies).toEqual([{ name: "Example Minerals Corp", website: "https://example-minerals.com", primary: true }]);
    expect(signals[0].raw.cost_usd).toBe(0.003);
  });

  it("an unparseable published_date leaves event_time null instead of dropping the paid batch", async () => {
    const doc = fixtureJson<{ data: { published_date?: string }[] }>("news-akta.json");
    doc.data[0].published_date = "yesterday-ish";
    monidRun.mockResolvedValue({ status: "COMPLETED", output: doc, cost_usd: 0.006, run_id: "run_2" });
    const { signals } = await fetchNews({ allowPaid: true });
    expect(signals.map((s) => s.event_time)).toEqual([null, "2026-11-04T09:30:00.000Z"]);
  });

  it("reports a refused or blocked run as a warning", async () => {
    monidRun.mockResolvedValue({ status: "REFUSED", output: null, cost_usd: 0, run_id: null, reason: "daily Monid cap" });
    expect(await fetchNews({ allowPaid: true })).toEqual({ signals: [], warnings: ["Monid REFUSED: daily Monid cap"] });
  });
});
