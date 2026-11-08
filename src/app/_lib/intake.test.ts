import { describe, expect, it } from "vitest";
import { AnswerBody, answerToRequest, parseLatLon, PortalForm, portalToRequest } from "./intake";

describe("portal form", () => {
  it("maps a filled form onto NewRequestInput and drops empty optional fields", () => {
    const f = PortalForm.parse({ location: " Paradise, CA ", question: "Did the fire reach Skyway?", email: " a@b.co ", name: "", company: "" });
    expect(portalToRequest(f)).toEqual({ question: "Did the fire reach Skyway?", location_text: "Paradise, CA", email: "a@b.co" });
  });

  it("turns typed coordinates into lat/lon", () => {
    expect(parseLatLon("-3.4653, -62.2159")).toEqual({ lat: -3.4653, lon: -62.2159 });
    expect(parseLatLon("95, 10")).toBeNull();
    expect(parseLatLon("12 Main St")).toBeNull();
    const f = PortalForm.parse({ location: "37.77 -122.42", question: "What changed here?", email: "a@b.co" });
    expect(portalToRequest(f)).toMatchObject({ lat: 37.77, lon: -122.42 });
  });

  it("explains missing fields in plain words", () => {
    const r = PortalForm.safeParse({ location: "", question: "hi", email: "nope" });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0])).toEqual(["location", "question", "email"]);
  });
});

describe("public API body", () => {
  it("accepts a location or a lat/lon pair", () => {
    expect(AnswerBody.safeParse({ question: "How much burned?", location: "Lahaina, HI" }).success).toBe(true);
    expect(answerToRequest(AnswerBody.parse({ question: "How much burned?", lat: 20.87, lon: -156.68 }))).toEqual({
      question: "How much burned?",
      lat: 20.87,
      lon: -156.68,
    });
  });

  it("rejects missing places, half coordinates, plain-http callbacks and unknown fields", () => {
    expect(AnswerBody.safeParse({ question: "How much burned?" }).success).toBe(false);
    expect(AnswerBody.safeParse({ question: "How much burned?", lat: 20 }).success).toBe(false);
    expect(AnswerBody.safeParse({ question: "How much burned?", location: "x y", callback_url: "http://a.com/cb" }).success).toBe(false);
    expect(AnswerBody.safeParse({ question: "How much burned?", location: "x y", lng: 3 }).success).toBe(false);
    expect(AnswerBody.safeParse({ question: "How much burned?", location: "x y", callback_url: "https://a.com/cb" }).success).toBe(true);
  });
});
