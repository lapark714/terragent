import { describe, expect, it } from "vitest";
import { EMAIL_PLACEHOLDER, NAME_PLACEHOLDER, scrubForAgent } from "./scrub";
import { toCallToolResult } from "./server";

describe("scrubForAgent", () => {
  it("removes names and email addresses but keeps everything an agent needs", () => {
    const req = {
      id: "req_1", question: "Did it flood? Reply to jane@acme.com", location_text: "Altadena, CA", lat: 34.19, lon: -118.13,
      customer_name: "Laurence", customer_email: "lapark714@gmail.com", company: "Acme", thread_id: "thr_1",
      contacts: [{ contact_name: "Jane Doe", contact_email: "jane@acme.com", contact_role: "Ops" }], to: ["a@b.co", "c@d.co"],
      providers: [{ name: "Planetary Computer", vendor: "Microsoft" }],
    };
    const out = scrubForAgent(req) as typeof req;
    expect(out.customer_name).toBe(NAME_PLACEHOLDER);
    expect(out.customer_email).toBe(EMAIL_PLACEHOLDER);
    expect(out.question).toBe(`Did it flood? Reply to ${EMAIL_PLACEHOLDER}`);
    expect(out.contacts[0]).toEqual({ contact_name: NAME_PLACEHOLDER, contact_email: EMAIL_PLACEHOLDER, contact_role: "Ops" });
    expect(out.to).toEqual([EMAIL_PLACEHOLDER, EMAIL_PLACEHOLDER]);
    expect(out.providers[0].name).toBe("Planetary Computer"); // generic "name" keys are not people
    expect(out).toMatchObject({ id: "req_1", location_text: "Altadena, CA", lat: 34.19, lon: -118.13, company: "Acme", thread_id: "thr_1" });
    expect(JSON.stringify(out)).not.toMatch(/@[a-z]+\.(com|co)/);
  });

  it("is applied at the MCP boundary", () => {
    const res = toCallToolResult({ customer_email: "x@y.com", ok: true });
    expect(res.content[0]).toMatchObject({ type: "text" });
    expect((res.content[0] as { text: string }).text).not.toContain("x@y.com");
  });
});

describe("name scrubbing in free text (live run #2: 'Customer: Laurence' in a brief flagged the chat)", () => {
  it("replaces the request's known person names, full and by token, in any string", async () => {
    const { scrubText, scrubForAgent: scrub } = await import("./scrub");
    expect(scrubText("Customer: Laurence, lapark714@gmail.com, no company.", ["Laurence"]))
      .toBe(`Customer: ${NAME_PLACEHOLDER}, ${EMAIL_PLACEHOLDER}, no company.`);
    expect(scrubText("Ask Jane Doe (Ops). Jane said the roof leaked; Doe agreed.", ["Jane Doe"]))
      .toBe(`Ask ${NAME_PLACEHOLDER} (Ops). ${NAME_PLACEHOLDER} said the roof leaked; ${NAME_PLACEHOLDER} agreed.`);
    expect(scrubText("Janet runs the mill", ["Jane"])).toBe("Janet runs the mill"); // whole words only
    const out = scrub({ events: [{ payload: { instructions: "Customer: Laurence" } }] }, undefined, ["Laurence"]) as { events: { payload: { instructions: string } }[] };
    expect(out.events[0].payload.instructions).toBe(`Customer: ${NAME_PLACEHOLDER}`);
  });
});
