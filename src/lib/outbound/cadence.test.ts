import { describe, expect, it } from "vitest";
import { isDue, nextRun, parseCadence } from "./cadence";

const at = (s: string) => new Date(s);
const next = (cron: string, after: string) => nextRun(parseCadence(cron)!, at(after))?.toISOString();

describe("cadence", () => {
  it("finds the next scheduled minute (UTC)", () => {
    expect(next("0 14 * * 1", "2026-11-07T15:00:00Z")).toBe("2026-11-09T14:00:00.000Z"); // Sat → Mon 14:00
    expect(next("*/15 * * * *", "2026-11-07T10:07:30Z")).toBe("2026-11-07T10:15:00.000Z");
    expect(next("0 9-17/4 * * *", "2026-11-07T13:00:00Z")).toBe("2026-11-07T17:00:00.000Z");
    expect(next("30 6 1 * *", "2026-11-07T00:00:00Z")).toBe("2026-12-01T06:30:00.000Z");
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00Z")).toBe("2028-02-29T00:00:00.000Z");
    expect(next("0 8 * * mon-fri", "2026-11-07T09:00:00Z")).toBe("2026-11-09T08:00:00.000Z");
    expect(next("0 0 * jan sun", "2026-11-07T00:00:00Z")).toBe("2027-01-03T00:00:00.000Z");
    expect(next("0 12 * * 7", "2026-11-07T00:00:00Z")).toBe("2026-11-08T12:00:00.000Z"); // 7 = Sunday
  });

  it("ORs day-of-month and day-of-week when both are set (classic cron)", () => {
    expect(next("0 0 15 * fri", "2026-11-07T00:00:00Z")).toBe("2026-11-13T00:00:00.000Z"); // Friday before the 15th
  });

  it("accepts macros and bare words, rejects junk", () => {
    expect(next("@daily", "2026-11-07T10:00:00Z")).toBe("2026-11-08T00:00:00.000Z");
    expect(next("weekly", "2026-11-07T10:00:00Z")).toBe("2026-11-08T00:00:00.000Z");
    expect(next("@hourly", "2026-11-07T10:00:00Z")).toBe("2026-11-07T11:00:00.000Z");
    for (const bad of ["", "every day", "61 * * * *", "* * * *", "*/0 * * * *", "5-1 * * * *"]) expect(parseCadence(bad)).toBeNull();
  });

  it("is due once a scheduled time has passed since the last check", () => {
    expect(isDue("0 14 * * 1", at("2026-11-02T14:05:00Z"), at("2026-11-07T12:00:00Z")).due).toBe(false);
    expect(isDue("0 14 * * 1", at("2026-11-02T14:05:00Z"), at("2026-11-09T14:00:00Z")).due).toBe(true);
    const fallback = isDue("whenever", at("2026-11-06T12:00:00Z"), at("2026-11-07T00:00:00Z"));
    expect(fallback).toMatchObject({ due: true, valid: false });
  });
});
