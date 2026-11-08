import { describe, expect, it } from "vitest";
import { demoFrame, skipToNext, type DemoClock } from "./playback";
import { demoSeries } from "./yc";

const T0 = Date.parse("2026-11-08T12:00:00Z");
const clock = (over: Partial<DemoClock> = {}): DemoClock => ({
  id: "req_demoabc123", question: "Q", location: "Y Combinator", startedAt: T0, acceptedAt: null, optionId: null,
  speed: 1, skipPre: 0, skipPost: 0, ...over,
});

describe("demoFrame", () => {
  it("starts received with the creation event", () => {
    const f = demoFrame(clock(), T0);
    expect(f.progress.status).toBe("received");
    expect(f.progress.events.map((e) => e.type)).toEqual(["request.created"]);
    expect(f.progress.quote).toBeNull();
  });

  it("waits on the quote until an option is accepted", () => {
    const f = demoFrame(clock(), T0 + 600_000);
    expect(f.progress.status).toBe("quoted");
    expect(f.progress.quote?.accept_url).toBeTruthy();
    expect(f.nextIn).toBeNull();
  });

  it("runs to delivered after acceptance, with a demo report link", () => {
    const f = demoFrame(clock({ acceptedAt: T0 + 60_000, optionId: "B" }), T0 + 600_000);
    expect(f.progress.status).toBe("delivered");
    expect(f.progress.terminal).toBe(true);
    expect(f.progress.report?.path).toBe("/demo/report/req_demoabc123");
    expect(f.progress.quote?.accepted_option_id).toBe("B");
    expect(f.progress.events.some((e) => e.type === "report.verified")).toBe(true);
  });

  it("speed and skip move the script forward", () => {
    expect(demoFrame(clock({ speed: 10 }), T0 + 3_000).progress.status).toBe("quoted");
    const c = clock();
    const skip = skipToNext(c, T0)!;
    expect(demoFrame({ ...c, ...skip }, T0).progress.status).toBe("screening");
  });

  it("never dates an event in the future", () => {
    const c = clock({ skipPre: 20 });
    for (const e of demoFrame(c, T0 + 1000).progress.events) expect(Date.parse(e.at)).toBeLessThanOrEqual(T0 + 1000);
  });
});

describe("demoSeries", () => {
  it("covers Jan 2016 to Oct 2026 with values in range", () => {
    const s = demoSeries();
    expect(s[0].month).toBe("2016-01");
    expect(s.at(-1)?.month).toBe("2026-10");
    for (const p of s) {
      expect(p.mv).toBeGreaterThanOrEqual(0);
      expect(p.sf).toBeLessThanOrEqual(1);
    }
  });
});
