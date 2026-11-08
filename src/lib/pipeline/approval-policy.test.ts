import { afterEach, describe, expect, it, vi } from "vitest";
import { policyAllows } from "./approval-policy";

describe("approval policy", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("allows only our own catalog-allowed gateway tools, for agents the catalog lists", () => {
    expect(policyAllows("comms-customer", "terragent.record_screening")).toBe(true);
    expect(policyAllows("planner", "terragent.geocode")).toBe(true);
    expect(policyAllows("comms-customer", "terragent.save_data_spec")).toBe(false); // not this agent's tool
    expect(policyAllows("acquisition", "terragent.place_paid_order")).toBe(false); // 'ask': always a human
    expect(policyAllows("comms-outreach", "email.send")).toBe(false); // Naïve built-in
    expect(policyAllows("comms-outreach", "browser")).toBe(false);
    expect(policyAllows("acquisition", "skywatch.get_offerings")).toBe(false); // another MCP server
    expect(policyAllows("planner", "terragent.geocode", "question")).toBe(false);
    expect(policyAllows(null, "terragent.geocode")).toBe(false);
    expect(policyAllows("not-an-agent", "terragent.geocode")).toBe(false);
  });
});
