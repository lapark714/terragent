import { describe, expect, it } from "vitest";
import { coarsen, coarsePlace, emailDomain, initials, maskPerson, scrubText, scrubValue, shortId } from "./mask";

describe("PII masking", () => {
  it("reduces people to initials and email domains", () => {
    expect(initials("Jane van Doe")).toBe("J.v.D.");
    expect(initials("  ")).toBeNull();
    expect(emailDomain("Jane.Doe@Acme.COM")).toBe("acme.com");
    expect(emailDomain("not-an-email")).toBeNull();
    expect(maskPerson({ name: "Jane Doe", email: "jane@acme.com" })).toBe("J.D. at acme.com");
    expect(maskPerson({ email: "jane@acme.com" })).toBe("acme.com");
    expect(maskPerson({})).toBeNull();
  });

  it("scrubs emails, phone numbers and house numbers from free text", () => {
    const out = scrubText("Did 42 Elm Street flood? Call +1 (415) 555-0134 or mail jane.doe@acme.com");
    expect(out).toBe("Did # Elm Street flood? Call [phone] or mail [email]");
    expect(scrubText("1600 Pennsylvania Ave NW, Washington DC")).toBe("# Pennsylvania Ave NW, Washington DC");
    expect(scrubText("Fire near Paradise, California in 2018")).toBe("Fire near Paradise, California in 2018");
    expect(scrubText("Coordinates -3.4653, -62.2159")).toBe("Coordinates -3.4653, -62.2159");
    expect(scrubText("Compare 2019-2023 and 2024-01-15")).toBe("Compare 2019-2023 and 2024-01-15");
    expect(scrubText(null)).toBe("");
  });

  it("cuts full request ids and report tokens, which would open a customer's pages", () => {
    expect(scrubText("req_abcdef2345 · planning → planner · Did 42 Elm St flood")).toBe("req_abcd · planning → planner · Did # Elm St flood");
    expect(scrubText("see https://terragent.ai/r/Tk3mPq8sXw2LbN7vRf5HjD9c and /api/files/fil_1?r=Tk3mPq8sXw2LbN7vRf5HjD9c")).toBe(
      "see https://terragent.ai/r/[token] and /api/files/fil_1?r=[token]",
    );
    expect(scrubValue({ request_id: "req_7k2mx9p3qa", order_id: "ord_x" })).toEqual({ request_id: "req_7k2m", order_id: "ord_x" });
  });

  it("scrubs European street numbers and UK postcodes without eating years or band names", () => {
    expect(scrubText("Hauptstraße 5, Berlin")).toBe("Hauptstraße #, Berlin");
    expect(scrubText("12 Rue de Rivoli, Paris")).toBe("# Rue de Rivoli, Paris");
    expect(scrubText("Via Roma 4, Milano")).toBe("Via Roma #, Milano");
    expect(scrubText("Keizersgracht 123, Amsterdam")).toBe("Keizersgracht #, Amsterdam");
    expect(scrubText("Baker Street, London NW1 6XE")).toBe("Baker Street, London [postcode]");
    expect(scrubText("Changes during 2019 and 2023 via Sentinel 2")).toBe("Changes during 2019 and 2023 via Sentinel 2");
    expect(scrubText("B04 and B08 bands, M4.1 quake")).toBe("B04 and B08 bands, M4.1 quake");
  });

  it("reduces a location to the locality after its street part", () => {
    expect(coarsePlace("42 Elm Street, Springfield")).toBe("Springfield");
    expect(coarsePlace("Flat 2, 5 Oak Ave, Leeds, UK")).toBe("Leeds, UK");
    expect(coarsePlace("Hauptstraße 5, 10115 Berlin")).toBe("Berlin");
    expect(coarsePlace("Houston, TX 77002")).toBe("Houston, TX");
    expect(coarsePlace("Jane Doe, 5 Oak Ave")).toBeNull();
    expect(coarsePlace("-3.4653, -62.2159")).toBeNull();
    expect(coarsePlace(null)).toBeNull();
  });

  it("coarsens coordinates and shortens ids", () => {
    expect(coarsen(37.774929)).toBe(37.8);
    expect(coarsen(-122.419416)).toBe(-122.4);
    expect(shortId("req_7k2mx9p3qa")).toBe("req_7k2m");
    expect(shortId(null)).toBe("");
  });

  it("scrubs nested tool arguments", () => {
    expect(scrubValue({ to: "a@b.co", nested: [{ note: "call 415-555-0134 now" }], n: 3 })).toEqual({
      to: "[email]",
      nested: [{ note: "call [phone] now" }],
      n: 3,
    });
  });
});
