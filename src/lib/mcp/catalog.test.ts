import { describe, expect, it } from "vitest";
import { AGENT_NAMES } from "../domain";
import { TOOLS, toolsForAgent } from "./catalog";

describe("MCP tool catalog", () => {
  it("has unique, Naïve-safe tool names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]{1,60}$/);
    expect(names.length).toBeLessThanOrEqual(100); // Naïve: ≤100 tools per MCP server
  });
  it("gives every agent at least one tool and only asks for paid orders", () => {
    for (const a of AGENT_NAMES) expect(toolsForAgent(a).length).toBeGreaterThan(0);
    expect(TOOLS.filter((t) => t.permission === "ask").map((t) => t.name)).toEqual(["place_paid_order"]);
  });
});
