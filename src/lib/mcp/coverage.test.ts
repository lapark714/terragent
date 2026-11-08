/** The catalog is the contract: every tool registered exactly once, by the group the catalog names. */
import { describe, expect, it } from "vitest";
import { TOOLS, type ToolGroup, toolSpec } from "./catalog";
import { collectRegistrations } from "./server";

const CORE_GROUPS: ToolGroup[] = ["core", "planning", "acquisition", "suppliers", "pricing", "analysis", "reports", "customer"];
const regs = collectRegistrations();
const count = (name: string) => regs.filter((r) => r.name === name).length;

describe("MCP catalog coverage", () => {
  it("registers nothing outside the catalog, nothing twice, and only in the catalog's group", () => {
    expect(regs.filter((r) => !toolSpec(r.name)).map((r) => `${r.group}:${r.name}`)).toEqual([]);
    expect(TOOLS.filter((t) => count(t.name) > 1).map((t) => t.name)).toEqual([]);
    expect(regs.filter((r) => toolSpec(r.name) && toolSpec(r.name)!.group !== r.group).map((r) => `${r.group}:${r.name}`)).toEqual([]);
  });

  it("core-owned groups implement all of their catalog tools", () => {
    expect(TOOLS.filter((t) => CORE_GROUPS.includes(t.group) && count(t.name) !== 1).map((t) => t.name)).toEqual([]);
  });

  it("every catalog tool is registered exactly once across ALL groups (lists the missing ones)", () => {
    expect(TOOLS.filter((t) => count(t.name) !== 1).map((t) => `${t.group}:${t.name}`)).toEqual([]);
  });
});
