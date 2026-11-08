import { describe, expect, it } from "vitest";
import { countGroups, outreachStatus, rate, sortProspects, type SignalProspect, totalConversion } from "./outreach";
import { feedLabel } from "./signals";

const pro = (id: string, status: string, score: number | null = null): SignalProspect => ({ id, company: id, domain: null, role: null, asset: null, score, status, channel: null, updatedAt: "" });

describe("feedLabel", () => {
  it("names known feeds and tidies unknown ones", () => {
    expect(feedLabel("usgs_quake")).toBe("USGS earthquakes");
    expect(feedLabel("some_new.feed")).toBe("Some new feed");
  });
});

describe("outreach", () => {
  it("groups statuses the way a founder reads them", () => {
    expect(outreachStatus("emailed").group).toBe("reached");
    expect(outreachStatus("paid").group).toBe("responded");
    expect(outreachStatus("sample_ready").group).toBe("pending");
    expect(outreachStatus("something_new")).toEqual({ label: "something new", group: "pending" });
    expect(countGroups([pro("a", "replied"), pro("b", "emailed"), pro("c", "matched"), pro("d", "opted_out")])).toEqual({ responded: 1, reached: 1, pending: 1, closed: 1 });
  });
  it("lists responders first, then best fit", () => {
    expect(sortProspects([pro("a", "matched", 0.9), pro("b", "emailed", 0.5), pro("c", "replied", 0.4), pro("d", "matched", 0.95)]).map((p) => p.id)).toEqual(["c", "b", "d", "a"]);
  });
  it("totals feeds and formats rates", () => {
    const row = { feed: "nws", playbook: "disasters" as const, signals: 4, matched: 2, reached: 2, replied: 1, quoted: 1, paid: 0, optedOut: 0 };
    expect(totalConversion([row, { ...row, feed: "firms", paid: 1 }])).toEqual({ signals: 8, matched: 4, reached: 4, replied: 2, quoted: 2, paid: 1, optedOut: 0 });
    expect(rate(1, 4)).toBe("25%");
    expect(rate(1, 0)).toBe("–");
  });
});
