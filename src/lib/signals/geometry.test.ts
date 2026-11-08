import { describe, expect, it } from "vitest";
import { clusterKeys, clusterPoints, radiusKm } from "./cluster";
import { convexHull, geometryPoints, hullPolygon, polygonCentroid } from "./geometry";
import { isoWeek } from "./types";

describe("geometry", () => {
  it("convex hull drops interior and duplicate points", () => {
    const hull = convexHull([[0, 0], [2, 0], [2, 2], [0, 2], [1, 1], [0, 0]]);
    expect(hull).toHaveLength(4);
    expect(hull).not.toContainEqual([1, 1]);
  });

  it("hullPolygon closes the ring, pads single points, and refuses no-area input", () => {
    const sq = hullPolygon([[0, 0], [1, 0], [1, 1], [0, 1]])!;
    expect(sq.coordinates[0][0]).toEqual(sq.coordinates[0].at(-1));
    const padded = hullPolygon([[10, 20]], 0.5)!;
    expect(padded.coordinates[0]).toHaveLength(5);
    expect(polygonCentroid(padded)).toEqual({ lat: 20, lon: 10 });
    expect(hullPolygon([[0, 0], [1, 1]])).toBeNull();
  });

  it("collects exterior rings from Polygon, MultiPolygon and GeometryCollection", () => {
    const poly = { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]], [[0.2, 0.2], [0.3, 0.2], [0.2, 0.3], [0.2, 0.2]]] };
    const multi = { type: "MultiPolygon", coordinates: [poly.coordinates, [[[5, 5], [6, 5], [6, 6], [5, 5]]]] };
    expect(geometryPoints(poly)).toHaveLength(4);
    expect(geometryPoints(multi)).toHaveLength(8);
    expect(geometryPoints({ type: "GeometryCollection", geometries: [poly, multi] })).toHaveLength(12);
    expect(geometryPoints(null)).toEqual([]);
  });

  it("area-weighted centroid of a square", () => {
    expect(polygonCentroid({ type: "Polygon", coordinates: [[[0, 0], [4, 0], [4, 2], [0, 2], [0, 0]]] })).toEqual({ lat: 1, lon: 2 });
  });
});

describe("cluster", () => {
  it("chains touching cells and separates distant points", () => {
    const fireA = [{ lat: 34.0, lon: -118.0 }, { lat: 34.005, lon: -118.005 }, { lat: 34.012, lon: -118.01 }];
    const fireB = [{ lat: 36.0, lon: -119.0 }];
    const groups = clusterPoints([...fireA, ...fireB]);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 3]);
  });

  it("keys clusters by res-6 cell and ISO week; a shared key gets each cluster's res-8 cell, in any order", () => {
    const first = new Date("2026-11-07T06:00:00Z");
    const a = { centre: { lat: 34, lon: -118 }, first };
    const b = { centre: { lat: 34.004, lon: -118.004 }, first }; // same res-6 cell, different res-8 cell
    const c = { centre: { lat: 36, lon: -119 }, first };
    const [ka, kb, kc] = clusterKeys("fire", [a, b, c]);
    expect(kc).toMatch(/^fire:86[0-9a-f]{13}:2026-W45$/);
    expect(ka).toMatch(/^fire:86[0-9a-f]{13}:2026-W45:88[0-9a-f]{13}$/);
    expect(ka).not.toBe(kb);
    expect(clusterKeys("fire", [c, b, a])).toEqual([kc, kb, ka]);
  });

  it("measures a cluster's footprint radius", () => {
    expect(radiusKm({ lat: 0, lon: 0 }, [{ lat: 0, lon: 0.01 }, { lat: 0, lon: -0.02 }])).toBeCloseTo(2.22, 1);
    expect(radiusKm({ lat: 0, lon: 0 }, [])).toBe(0);
  });

  it("computes ISO weeks across year boundaries", () => {
    expect(isoWeek(new Date("2026-11-07T00:00:00Z"))).toBe("2026-W45");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeek(new Date("2024-12-30T00:00:00Z"))).toBe("2025-W01");
  });
});
