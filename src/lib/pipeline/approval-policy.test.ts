import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERRAGENT_MCP_SERVER, toolSpec } from "../mcp/catalog";
import { applyApprovalPolicy, CONFIRM_FIRST, confirmOrder, policyAllows } from "./approval-policy";

type Pending = { kind: "tool" | "question"; tool_call_id: string; name: string; args: Record<string, unknown> };
type ConfirmBody = { tool_call_id: string; decision: "allow" | "deny"; scope?: "call" | "session"; reason?: string };

// A fake Naïve: sessions.get returns the parked rows, agents.get the agent's own tool configs, confirmTool is a spy.
const h = vi.hoisted(() => {
  const state = { pending: [] as Pending[], configs: {} as Record<string, { permission?: string; enabled?: boolean; config?: { ask_actions?: string[] } }> };
  const confirmTool = vi.fn(async (_sessionId: string, _body: ConfirmBody) => ({ id: _sessionId }));
  const getNaive = vi.fn(async () => ({
    sessions: { get: vi.fn(async (id: string) => ({ id, agent_id: "agt_test", pending_actions: state.pending })), confirmTool },
    agents: { get: vi.fn(async () => ({ tools: { configs: state.configs } })) },
  }));
  const logEvent = vi.fn(async (_type: string, _actor: string, _payload?: Record<string, unknown>, _requestId?: string | null) => {});
  return { state, confirmTool, getNaive, logEvent };
});
vi.mock("../naive/client", () => ({ getNaive: h.getNaive }));
vi.mock("../events", () => ({ logEvent: h.logEvent }));

const tool = (name: string, tool_call_id: string, args: Record<string, unknown> = {}): Pending => ({ kind: "tool", tool_call_id, name, args });
const t = (n: string) => `${TERRAGENT_MCP_SERVER}.${n}`;
const confirmedIds = () => h.confirmTool.mock.calls.map(([, body]) => body.tool_call_id);
const eventsOf = (type: string) => h.logEvent.mock.calls.filter(([ty]) => ty === type).map(([, , payload, requestId]) => ({ payload, requestId }));

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

describe("confirmOrder", () => {
  it("puts turn-ending and outbound calls first and log_decision last, keeping pending order inside each group", () => {
    const rows = [
      { name: t("log_decision"), id: 1 }, { name: t("handoff"), id: 2 }, { name: t("log_decision"), id: 3 },
      { name: t("set_status"), id: 4 }, { name: t("save_acquisition_plan"), id: 5 }, { name: "submit_output", id: 6 },
      { name: null, id: 7 }, { name: t("send_quote"), id: 8 }, { id: 9 },
    ];
    const before = rows.map((r) => r.id);
    expect(confirmOrder(rows).map((r) => r.id)).toEqual([2, 4, 6, 8, 5, 7, 9, 1, 3]);
    expect(rows.map((r) => r.id)).toEqual(before); // input untouched
    const saves = [{ name: t("add_note") }, { name: t("save_acquisition_plan") }, { name: t("save_data_spec") }];
    expect(confirmOrder(saves)).toEqual(saves); // nothing to move: order unchanged
    const logged = [{ name: t("log_decision") }, { name: t("add_note") }, { name: t("save_acquisition_plan") }];
    expect(confirmOrder(logged)).toEqual([logged[1], logged[2], logged[0]]);
    expect(confirmOrder([])).toEqual([]);
  });

  it("names only real catalog tools (or Naïve's submit_output)", () => {
    for (const name of CONFIRM_FIRST) {
      if (name === "submit_output") continue;
      expect(name.startsWith(`${TERRAGENT_MCP_SERVER}.`), name).toBe(true);
      expect(toolSpec(name.slice(`${TERRAGENT_MCP_SERVER}.`.length)), name).toBeDefined();
    }
  });
});

describe("applyApprovalPolicy", () => {
  beforeEach(() => {
    vi.stubEnv("AUTO_APPROVE_GATEWAY_TOOLS", "true");
    h.state.pending = [];
    h.state.configs = {};
  });
  afterEach(() => {
    // Every confirm in every test is a one-call allow: never a session-wide grant.
    for (const [, body] of h.confirmTool.mock.calls) expect(body.scope).toBe("call");
    h.confirmTool.mockClear();
    h.getNaive.mockClear();
    h.logEvent.mockClear();
    vi.unstubAllEnvs();
  });

  it("confirms the ses_nb14 batch handoff first and the decisions last, so the model's first re-issue is a decision", async () => {
    h.state.pending = [
      tool(t("log_decision"), "tc1", { choice: "free" }), tool(t("log_decision"), "tc2"),
      tool(t("save_acquisition_plan"), "tc3", { plan: { customer_note: "private text" } }), tool(t("handoff"), "tc4", { to: "pricing" }),
    ];
    const out = await applyApprovalPolicy("ses_nb14", "acquisition", "req_1");

    expect(confirmedIds()).toEqual(["tc4", "tc3", "tc1", "tc2"]);
    for (const [sessionId, body] of h.confirmTool.mock.calls) {
      expect(sessionId).toBe("ses_nb14");
      expect(body).toMatchObject({ decision: "allow", scope: "call" });
    }
    expect(out).toEqual({ allowed: [t("handoff"), t("save_acquisition_plan"), t("log_decision"), t("log_decision")], held: [] });

    const allowed = eventsOf("approval.auto_allowed");
    expect(allowed.map((e) => e.payload)).toEqual([
      { session_id: "ses_nb14", agent: "acquisition", tool: t("handoff"), tool_call_id: "tc4", position: 1, of: 4 },
      { session_id: "ses_nb14", agent: "acquisition", tool: t("save_acquisition_plan"), tool_call_id: "tc3", position: 2, of: 4 },
      { session_id: "ses_nb14", agent: "acquisition", tool: t("log_decision"), tool_call_id: "tc1", position: 3, of: 4 },
      { session_id: "ses_nb14", agent: "acquisition", tool: t("log_decision"), tool_call_id: "tc2", position: 4, of: 4 },
    ]);
    expect(allowed.every((e) => e.requestId === "req_1")).toBe(true);
    expect(JSON.stringify(h.logEvent.mock.calls)).not.toContain("private text"); // args are never logged
  });

  it("passes scope 'call' on every confirm, never 'session'", async () => {
    h.state.pending = [tool(t("handoff"), "tcA"), tool(t("add_note"), "tcB"), tool("browser", "tcC", { action: "goto" })];
    h.state.configs = { browser: { permission: "allow" } };
    await applyApprovalPolicy("ses_scope", "comms-outreach", null);
    expect(h.confirmTool).toHaveBeenCalledTimes(3);
    expect(h.confirmTool.mock.calls.map(([, body]) => body.scope)).toEqual(["call", "call", "call"]);
  });

  describe("browser calls", () => {
    // The live comms-outreach config (GET /v1/agents, 2026-11-08), with contact forms still gated in one case below.
    const LIVE = { enabled: true, permission: "allow", config: { ask_actions: ["signup", "login"] } };

    it("holds signup and login under the live config, wherever they sit in the batch", async () => {
      h.state.configs = { browser: LIVE };
      h.state.pending = [tool("browser", "tcSign", { action: "signup" }), tool(t("add_note"), "tcNote"), tool("browser", "tcLogin", { action: "login" })];
      const out = await applyApprovalPolicy("ses_browser", "comms-outreach", "req_b");
      expect(confirmedIds()).toEqual(["tcNote"]);
      expect(out).toEqual({ allowed: [t("add_note")], held: ["browser", "browser"] });
    });

    it("never clears signup or login, even if the config's ask_actions drops them", async () => {
      h.state.configs = { browser: { permission: "allow", config: { ask_actions: [] } } };
      h.state.pending = [tool("browser", "tcSign", { action: "signup" }), tool("browser", "tcLogin", { action: "login" })];
      const out = await applyApprovalPolicy("ses_browser", "comms-outreach", null);
      expect(h.confirmTool).not.toHaveBeenCalled();
      expect(out.held).toEqual(["browser", "browser"]);
    });

    it("holds an action the agent's own ask_actions reserves for a person", async () => {
      h.state.configs = { browser: { permission: "allow", config: { ask_actions: ["signup", "login", "click"] } } };
      h.state.pending = [tool("browser", "tcClick", { action: "click" }), tool("browser", "tcGoto", { action: "goto" })];
      const out = await applyApprovalPolicy("ses_browser", "comms-outreach", null);
      expect(confirmedIds()).toEqual(["tcGoto"]);
      expect(out).toEqual({ allowed: ["browser"], held: ["browser"] });
    });

    it("holds a browser row with no string action (the row shape is unconfirmed, so it fails closed)", async () => {
      h.state.configs = { browser: LIVE };
      h.state.pending = [tool("browser", "tcNone"), tool("browser", "tcNum", { action: 7 }), { kind: "tool", tool_call_id: "tcBare", name: "browser" } as unknown as Pending];
      const out = await applyApprovalPolicy("ses_browser", "comms-outreach", null);
      expect(h.confirmTool).not.toHaveBeenCalled();
      expect(out.held).toEqual(["browser", "browser", "browser"]);
    });
  });

  it("never confirms place_paid_order, email.send or a question, wherever they sit in the batch", async () => {
    const batch = [
      tool(t("place_paid_order"), "tcPaid"), tool(t("handoff"), "tcHand"), tool(t("add_note"), "tcNote"),
      tool("email.send", "tcMail"),
      { kind: "question" as const, tool_call_id: "tcAsk", name: "ask_operator", args: {} },
      { kind: "question" as const, tool_call_id: "tcAsk2", name: t("set_status"), args: {} }, // a question is never a call, whatever its name
    ];
    h.state.configs = { "email.send": { permission: "allow" } }; // configured allow does not beat the NEVER list
    const never = ["tcPaid", "tcMail", "tcAsk", "tcAsk2"];
    // Every rotation of the batch, forwards and reversed, so each held row is tried first, last and in between.
    const orders = batch.flatMap((_, i) => {
      const rotated = [...batch.slice(i), ...batch.slice(0, i)];
      return [rotated, [...rotated].reverse()];
    });
    for (const pending of orders) {
      h.state.pending = pending;
      h.confirmTool.mockClear();
      const out = await applyApprovalPolicy("ses_mixed", "acquisition", "req_2");
      expect(confirmedIds()).toEqual(["tcHand", "tcNote"]);
      expect(confirmedIds().some((id) => never.includes(id))).toBe(false);
      expect(out.allowed).toEqual([t("handoff"), t("add_note")]);
      expect([...out.held].sort()).toEqual([t("place_paid_order"), t("set_status"), "ask_operator", "email.send"].sort());
    }
  });

  it("keeps confirming the rest of the batch when one confirm fails, and holds the failed call", async () => {
    h.state.pending = [tool(t("log_decision"), "tc1"), tool(t("handoff"), "tc2"), tool(t("save_acquisition_plan"), "tc3")];
    h.confirmTool.mockRejectedValueOnce(new Error(`409 already resolved ${"x".repeat(500)}`));
    const out = await applyApprovalPolicy("ses_fail", "acquisition", "req_3");

    expect(confirmedIds()).toEqual(["tc2", "tc3", "tc1"]); // the handoff (first) failed; the other two still went through
    expect(out).toEqual({ allowed: [t("save_acquisition_plan"), t("log_decision")], held: [t("handoff")] });
    const [failed, ...more] = eventsOf("approval.policy_failed");
    expect(more).toHaveLength(0);
    expect(failed.requestId).toBe("req_3");
    expect(failed.payload).toMatchObject({ session_id: "ses_fail", agent: "acquisition", tool: t("handoff"), tool_call_id: "tc2" });
    expect(String(failed.payload?.error)).toMatch(/^409 already resolved/);
    expect(String(failed.payload?.error)).toHaveLength(300);
    expect(eventsOf("approval.auto_allowed").map((e) => e.payload?.tool_call_id)).toEqual(["tc3", "tc1"]);
  });

  describe("a failed audit event never stops the batch", () => {
    const batch = () => [tool(t("log_decision"), "tc1"), tool(t("handoff"), "tc2"), tool(t("save_acquisition_plan"), "tc3")];
    const quiet = () => vi.spyOn(console, "error").mockImplementation(() => {});
    afterEach(() => vi.restoreAllMocks());

    it("confirms every row and returns when the auto_allowed insert fails", async () => {
      const logged = quiet();
      h.state.pending = batch();
      h.logEvent.mockRejectedValueOnce(new Error("Neon: connection terminated"));
      const out = await applyApprovalPolicy("ses_audit", "acquisition", "req_5");

      expect(confirmedIds()).toEqual(["tc2", "tc3", "tc1"]);
      expect(out).toEqual({ allowed: [t("handoff"), t("save_acquisition_plan"), t("log_decision")], held: [] });
      expect(logged).toHaveBeenCalledWith("[approval-policy] event log failed:", "approval.auto_allowed", "Neon: connection terminated");
    });

    it("keeps going when a confirm and its policy_failed insert both fail", async () => {
      const logged = quiet();
      h.state.pending = batch();
      h.confirmTool.mockRejectedValueOnce(new Error("503 upstream"));
      h.logEvent.mockRejectedValueOnce(new Error("Neon: connection terminated"));
      const out = await applyApprovalPolicy("ses_audit", "acquisition", "req_6");

      expect(confirmedIds()).toEqual(["tc2", "tc3", "tc1"]);
      expect(out).toEqual({ allowed: [t("save_acquisition_plan"), t("log_decision")], held: [t("handoff")] });
      expect(logged).toHaveBeenCalledWith("[approval-policy] event log failed:", "approval.policy_failed", "Neon: connection terminated");
    });
  });

  it("does nothing, not even a Naïve lookup, when AUTO_APPROVE_GATEWAY_TOOLS is off", async () => {
    vi.stubEnv("AUTO_APPROVE_GATEWAY_TOOLS", "false");
    h.state.pending = [tool(t("handoff"), "tc1")];
    expect(await applyApprovalPolicy("ses_off", "acquisition", "req_4")).toEqual({ allowed: [], held: [] });
    expect(h.getNaive).not.toHaveBeenCalled();
    expect(h.confirmTool).not.toHaveBeenCalled();
    expect(h.logEvent).not.toHaveBeenCalled();
  });
});
