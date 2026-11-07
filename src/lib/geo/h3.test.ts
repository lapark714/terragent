import { describe, expect, it } from "vitest";
import { bboxAround, bboxAreaKm2, bboxToPolygon, cellCenter, pointCell, polygonCells, toResolution } from "./h3";

describe("h3 helpers", () => {
  it("builds a ~2 km AOI and covers it with res-8 cells", () => {
    const bbox = bboxAround(34.05, -118.25, 2);
    expect(bboxAreaKm2(bbox)).toBeGreaterThan(3.8);
    expect(bboxAreaKm2(bbox)).toBeLessThan(4.2);
    const cells = polygonCells(bboxToPolygon(bbox), 8);
    expect(cells.length).toBeGreaterThan(2);
    expect(cells).toContain(pointCell(34.05, -118.25, 8));
  });
  it("round-trips a cell centre and aggregates to coarser resolutions", () => {
    const c = pointCell(-3.1, -60.0, 8);
    const { lat, lon } = cellCenter(c);
    expect(Math.abs(lat + 3.1)).toBeLessThan(0.01);
    expect(Math.abs(lon + 60.0)).toBeLessThan(0.01);
    expect(toResolution(c, 4)).not.toBe(c);
  });
  it("returns the centroid cell for an AOI smaller than one cell", () => {
    expect(polygonCells(bboxToPolygon(bboxAround(51.5, -0.12, 0.05)), 8)).toHaveLength(1);
  });
});
