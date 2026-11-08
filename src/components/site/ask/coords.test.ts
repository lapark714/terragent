import { describe, expect, it } from "vitest";
import { formatCoords, parseCoords, prettyCoords } from "./coords";

const near = (got: { lat: number; lng: number } | null, lat: number, lng: number) => {
  expect(got).not.toBeNull();
  expect(got!.lat).toBeCloseTo(lat, 3);
  expect(got!.lng).toBeCloseTo(lng, 3);
};

describe("parseCoords", () => {
  it("reads decimal pairs with comma or space", () => {
    near(parseCoords("20.874, -156.678"), 20.874, -156.678);
    near(parseCoords("20.874 -156.678"), 20.874, -156.678);
    near(parseCoords("-9.97,-63.03"), -9.97, -63.03);
  });

  it("reads hemisphere letters before or after, in either order", () => {
    near(parseCoords("20.874N 156.678W"), 20.874, -156.678);
    near(parseCoords("N 20.874, W 156.678"), 20.874, -156.678);
    near(parseCoords("156.678W 20.874N"), 20.874, -156.678);
    near(parseCoords("33.9S 18.4E"), -33.9, 18.4);
  });

  it("reads degrees, minutes and seconds", () => {
    near(parseCoords(`20°52'26"N 156°40'40"W`), 20.8739, -156.6778);
    near(parseCoords("20° 52′ 26″ N, 156° 40′ 40″ W"), 20.8739, -156.6778);
  });

  it("reads map links", () => {
    near(parseCoords("https://www.google.com/maps/place/Lahaina/@20.8783,-156.6825,14z"), 20.8783, -156.6825);
    near(parseCoords("https://maps.apple.com/?ll=20.87,-156.68&q=Lahaina"), 20.87, -156.68);
    near(parseCoords("https://www.openstreetmap.org/#map=13/20.8738/-156.6776"), 20.8738, -156.6776);
  });

  it("rejects places, out-of-range numbers and lone numbers", () => {
    expect(parseCoords("Lahaina, Hawaii")).toBeNull();
    expect(parseCoords("123 Main Street")).toBeNull();
    expect(parseCoords("95, 10")).toBeNull();
    expect(parseCoords("10, 200")).toBeNull();
    expect(parseCoords("42")).toBeNull();
    expect(parseCoords("")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats for the server and for people", () => {
    expect(formatCoords({ lat: 20.8738769, lng: -156.677678 })).toBe("20.87388, -156.67768");
    expect(prettyCoords({ lat: 20.8738769, lng: -156.677678 })).toBe("20.874° N, 156.678° W");
  });
});
