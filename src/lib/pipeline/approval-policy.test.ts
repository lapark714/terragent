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
    expect(policyAllows("comms-outreach", "browser")).toBe(false); // no config passed
    const cfg = { browser: { permission: "allow" }, web_fetch: { permission: "allow" }, "email.send": { permission: "allow" }, bash: { permission: "deny" } };
    expect(policyAllows("comms-outreach", "browser", "tool", cfg)).toBe(true); // configured allow → re-applied
    expect(policyAllows("comms-outreach", "web_fetch", "tool", cfg)).toBe(true);
    expect(policyAllows("comms-outreach", "bash", "tool", cfg)).toBe(false); // configured deny stays denied
    expect(policyAllows("comms-outreach", "email.send", "tool", cfg)).toBe(false); // NEVER list beats config
    expect(policyAllows("acquisition", "terragent.place_paid_order", "tool", { "terragent.place_paid_order": { permission: "allow" } })).toBe(false);
    expect(policyAllows("acquisition", "skywatch.get_offerings")).toBe(false); // another MCP server
    expect(policyAllows("planner", "terragent.geocode", "question")).toBe(false);
    expect(policyAllows(null, "terragent.geocode")).toBe(false);
    expect(policyAllows("not-an-agent", "terragent.geocode")).toBe(false);
  });
});
