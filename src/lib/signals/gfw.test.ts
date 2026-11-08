import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalInput } from "../domain";
import { fixture, fixtureJson, json, mockFetch, text } from "./__fixtures__/fetch-mock";
import { fetchGfw, forestLossSeverity, gfwOrigin } from "./gfw";

const RONDONIA: [number, number, number, number] = [-63, -10, -62, -9];

describe("gfw", () => {
  beforeEach(() => {
    vi.stubEnv("PUBLIC_BASE_URL", "");
    vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("without a key uses the keyless download route, warns, and clusters alert pixels", async () => {
    vi.stubEnv("GFW_API_KEY", "");
    const calls = mockFetch([["/download/json", text(fixture("gfw-integrated-alerts.json"))]]);
    const { signals, warnings } = await fetchGfw({ bbox: RONDONIA, since: new Date("2026-10-31T00:00:00Z") });
    expect(warnings).toEqual([expect.stringMatching(/GFW_API_KEY not set/)]);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://data-api.globalforestwatch.org/dataset/gfw_integrated_alerts/latest/download/json");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.sql).toContain("gfw_integrated_alerts__date >= '2026-10-31'");
    expect(body.sql).toContain("!= 'nominal'");
    expect(body.geometry.coordinates[0]).toEqual([[-63, -10], [-62, -10], [-62, -9], [-63, -9], [-63, -10]]);
    expect((calls[0].init.headers as Record<string, string>).origin).toBe("localhost");

    expect(signals.length).toBeGreaterThan(0);
    for (const s of signals) {
      expect(SignalInput.safeParse(s).success).toBe(true);
      expect(s).toMatchObject({ playbook: "deforestation", feed: "gfw" });
      expect(s.external_id).toMatch(/^forest:86[0-9a-f]{13}:2026-W\d\d(:88[0-9a-f]{13})?$/);
      expect(s.raw.pixels as number).toBeGreaterThanOrEqual(10);
      expect(s.lat!).toBeGreaterThan(-10);
      expect(s.lat!).toBeLessThan(-9);
    }
  });

  it("with a key queries /query/json with x-api-key and origin", async () => {
    vi.stubEnv("GFW_API_KEY", "gfw-secret");
    vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.vercel.app");
    const rows = fixtureJson<unknown[]>("gfw-integrated-alerts.json");
    const calls = mockFetch([["/query/json", json({ data: rows, status: "success" })]]);
    const { signals, warnings } = await fetchGfw({ bbox: RONDONIA });
    expect(warnings).toEqual([]);
    expect(calls[0].url).toMatch(/\/latest\/query\/json$/);
    expect(calls[0].init.headers).toMatchObject({ "x-api-key": "gfw-secret", origin: "terragent.vercel.app" });
    expect(signals.length).toBeGreaterThan(0);
  });

  it("turns API errors into warnings per region, never throws", async () => {
    vi.stubEnv("GFW_API_KEY", "gfw-secret");
    const calls = mockFetch([["globalforestwatch", json({ status: "failed", message: "Request is missing valid API key" }, 403)]]);
    const { signals, warnings } = await fetchGfw({});
    expect(signals).toEqual([]);
    expect(calls).toHaveLength(8); // every forest watch region
    expect(warnings).toHaveLength(8);
    expect(warnings[0]).toContain("HTTP 403");
    expect(warnings.join(" ")).not.toContain("gfw-secret");
  });

  it("derives the origin header from the public URL", () => {
    expect(gfwOrigin()).toBe("localhost");
    vi.stubEnv("PUBLIC_BASE_URL", "https://terragent-git-main.vercel.app/");
    expect(gfwOrigin()).toBe("terragent-git-main.vercel.app");
  });

  it("scores severity by cleared area", () => {
    expect(forestLossSeverity(60)).toBe("extreme");
    expect(forestLossSeverity(12)).toBe("severe");
    expect(forestLossSeverity(1.5)).toBe("moderate");
    expect(forestLossSeverity(0.2)).toBe("minor");
  });
});
