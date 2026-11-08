/** Live, free: one Census address and one Nominatim place (1 req/s policy). No paid fallback. */
import { expect, it } from "vitest";
import { censusGeocode, nominatimGeocode } from "./geocode";

it("Census resolves a public US address with county FIPS", async () => {
  const r = await censusGeocode("1 Dr Carlton B Goodlett Pl, San Francisco, CA 94102");
  console.log(r);
  expect(r).toMatchObject({ geocoder: "census", county_fips: "06075" });
});

it("Nominatim resolves a place name", async () => {
  const r = await nominatimGeocode("Arcadia, Florida");
  console.log(r);
  expect(r?.country_code).toBe("us");
  expect(r!.lat).toBeCloseTo(27.2, 0);
});
