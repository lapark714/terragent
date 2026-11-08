/**
 * Live, free: runs the real Python pipeline against Planetary Computer (needs `bash pipeline/bootstrap.sh`).
 * Run: npx vitest run --config vitest.live.config.mts src/lib/imagery/local-pipeline.live.test.ts
 */
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPipelineLocally, type PipelineJob } from "./local-pipeline";

const job = (patch: Partial<PipelineJob>): PipelineJob => ({
  request_id: "req_live",
  recipe: "true_color",
  bbox: [-118.2608, 34.041, -118.2392, 34.059],
  before_window: null,
  after_window: { start: "2026-09-01", end: "2026-11-07" },
  before_scene: null,
  after_scene: null,
  max_cloud_pct: 20,
  h3_res: 8,
  ...patch,
});

describe("runPipelineLocally (live)", () => {
  it("detects the January 2025 Eaton fire with dNBR", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tg-eaton-"));
    const r = await runPipelineLocally(
      job({
        recipe: "burn_severity",
        bbox: [-118.11086, 34.19096, -118.08914, 34.20904],
        before_window: { start: "2024-12-01", end: "2024-12-31" },
        after_window: { start: "2025-02-01", end: "2025-02-28" },
      }),
      out,
    );
    console.log("Eaton timings", r.timings_s, r.warnings);
    const dnbr = r.indices.find((i) => i.name === "dnbr")!;
    expect(dnbr.delta).toBeGreaterThan(0.1); // mean dNBR: USGS "low severity" or worse
    expect(dnbr.affected_area_km2).toBeGreaterThan(1);
    expect(r.images.map((i) => i.role)).toEqual(["before", "after", "index", "change"]);
    for (const img of r.images) expect(existsSync(path.join(out, img.path))).toBe(true);
    expect(r.h3_metrics.some((m) => m.metric === "dnbr_mean")).toBe(true);
    expect(r.timings_s.total).toBeLessThan(60);
  });

  it("returns the latest clear true-colour image of downtown LA", async () => {
    const out = await mkdtemp(path.join(tmpdir(), "tg-la-"));
    const r = await runPipelineLocally(job({}), out);
    console.log("LA timings", r.timings_s, r.warnings);
    expect(r.after?.clear_fraction).toBeGreaterThan(0.8);
    expect(r.indices[0].after_mean).toBeGreaterThan(0);
    expect(r.indices[0].after_mean).toBeLessThan(0.3); // dense city
  });
});
