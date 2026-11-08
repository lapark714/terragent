/** Live, free, anonymous: Planetary Computer STAC + data API. Run: npx vitest run --config vitest.live.config.mts src/lib/imagery/stac.live.test.ts */
import { describe, expect, it } from "vitest";
import type { BBox } from "../domain";
import { previewUrl, searchFreeScenes } from "./stac";

const LA: BBox = [-118.2608, 34.041, -118.2392, 34.059];
const EATON: BBox = [-118.11086, 34.19096, -118.08914, 34.20904];

describe("searchFreeScenes (live)", () => {
  it("finds clear before/after scenes for downtown LA in a few seconds", async () => {
    const t0 = Date.now();
    const r = await searchFreeScenes({
      bbox: LA,
      after: { start: "2026-09-01", end: "2026-11-07" },
      before: { start: "2025-09-01", end: "2025-11-07" },
      maxCloudPct: 20,
    });
    const ms = Date.now() - t0;
    console.log(`searchFreeScenes LA: ${ms} ms`, r.notes);
    expect(r.after?.aoi_clear_fraction).toBeGreaterThanOrEqual(0.8);
    expect(r.before?.aoi_clear_fraction).toBeGreaterThanOrEqual(0.8);
    expect(r.before?.mgrs_tile).toBe(r.after?.mgrs_tile);
    expect(ms).toBeLessThan(10_000);

    const png = await fetch(r.after!.preview_url!);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const ndvi = await fetch(previewUrl(r.after!, LA, "ndvi", 256));
    expect(ndvi.status).toBe(200);
  });

  it("finds the Eaton fire pre/post scenes", async () => {
    const r = await searchFreeScenes({
      bbox: EATON,
      before: { start: "2024-12-01", end: "2024-12-31" },
      after: { start: "2025-02-01", end: "2025-02-28" },
      maxCloudPct: 20,
    });
    console.log("searchFreeScenes Eaton:", r.notes);
    expect(r.before?.datetime.slice(0, 7)).toBe("2024-12");
    expect(r.after?.datetime.slice(0, 7)).toBe("2025-02");
  });
});
