/** Read-only, $0 live checks: run with `npx vitest run --config vitest.live.config.mts src/lib/naive/naive.live.test.ts`. */
import { describe, expect, it } from "vitest";
import { SKYWATCH_MCP, SKYWATCH_TOOLS } from "../../../naive/index";
import { AGENT_BUDGETS } from "../config";
import { fetchKeyScopes, naive } from "./client";

describe("Naïve (live)", () => {
  it("reads the key's scopes from /v1/me", async () => {
    const scopes = await fetchKeyScopes();
    expect(scopes).toContain("agents:read");
  });

  it("serves every configured model in its configured window", async () => {
    for (const [agent, b] of Object.entries(AGENT_BUDGETS)) {
      const m = await naive().models.retrieve(b.model);
      expect(m.supported_windows, `${agent} → ${b.model}`).toContain(b.window);
    }
  });
});

describe("SkyWatch public MCP (live)", () => {
  it("still exposes the tool names acquisition is configured with", async () => {
    const res = await fetch(SKYWATCH_MCP.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    const names = body.result.tools.map((t) => t.name);
    for (const tool of Object.keys(SKYWATCH_TOOLS)) expect(names).toContain(tool);
  });
});
