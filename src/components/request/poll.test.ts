import { describe, expect, it } from "vitest";
import { pollIntervalMs } from "./poll";

const now = Date.parse("2026-11-08T12:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();
const open = (updated: number, events: number[] = []) => ({ terminal: false, updatedAt: minutesAgo(updated), events: events.map((m) => ({ type: "x", actor: "planner", at: minutesAgo(m) })) });

describe("status page polling", () => {
  it("polls no faster than the server cache while a request is moving", () => {
    expect(pollIntervalMs(open(0.5), now)).toBe(8_000);
    expect(pollIntervalMs(open(1), null)).toBe(8_000); // before the client clock starts
  });

  it("backs off once nothing has happened for a while, counting the latest event too", () => {
    expect(pollIntervalMs(open(10), now)).toBe(20_000);
    expect(pollIntervalMs(open(10, [2]), now)).toBe(8_000);
    expect(pollIntervalMs(open(45), now)).toBe(60_000);
  });

  it("only checks now and then once the request is finished", () => {
    expect(pollIntervalMs({ ...open(0), terminal: true }, now)).toBe(120_000);
  });
});
