/** PRICING v2 (NOTES 2026-11-08): agent prompts and playbook skills match the quote-options contract and the catalog. */
import { describe, expect, it } from "vitest";
import { AGENT_NAMES, type AgentName } from "../src/lib/domain";
import { toolsForAgent } from "../src/lib/mcp/catalog";
import { buildAllAgentConfigs } from "../naive/index";
import { loadAllSkills } from "../naive/skills";

const configs = buildAllAgentConfigs({ publicBaseUrl: "https://terragent.example.app", contactFormsApproved: false });
const system = (a: AgentName) => configs[a].system ?? "";
const granted = (a: AgentName) =>
  new Set(Object.entries(configs[a].tools!.configs).filter(([, c]) => c.enabled && c.permission !== "deny").map(([k]) => k));
/** "terragent.x" / "skywatch.x" tool names a prompt tells its agent to call. */
const named = (text: string) => [...new Set([...text.matchAll(/\b(?:terragent|skywatch)\.[a-z_]+/g)].map((m) => m[0]))];
const priceSection = (content: string) => content.slice(content.indexOf("## Price"));

describe("sourcing", () => {
  it("checks a business can be reached before spending on a free sample", () => {
    const prompt = system("sourcing");
    expect(prompt.indexOf("check the business can be reached")).toBeGreaterThan(-1);
    expect(prompt.indexOf("check the business can be reached")).toBeLessThan(prompt.indexOf("request free samples"));
    expect(prompt).toMatch(/consumer complaint or support form[^.]*does not count/);
  });
});

/** Claims that contradict "no free answers, nothing auto-approved, nothing starts before acceptance". */
const FORBIDDEN = [
  /auto-?approv/i,
  /free-data reports?/i,
  /\b(?:reports?|answers?) (?:is|are) free\b/i,
  /\bfree (?:reports?|answers?) (?:is|are)\b/i,
  /quote_accepted/,
  /under the cap/i,
];

describe("PRICING v2 prompts", () => {
  it.each(AGENT_NAMES)("%s: every terragent./skywatch. tool its prompt names is granted in tools.configs", (a) => {
    const have = granted(a);
    expect(named(system(a)).filter((t) => !have.has(t))).toEqual([]);
  });

  it("uses the contract's tool names, and the catalog grants them to the right agents", () => {
    expect(system("pricing")).toMatch(/terragent\.price_options[\s\S]*terragent\.create_quote/);
    expect(system("comms-customer")).toContain("terragent.send_quote");
    expect(system("comms-customer")).toContain("terragent.accept_quote({ request_id, option_id, evidence })");
    expect(toolsForAgent("pricing").map((t) => t.name)).toEqual(expect.arrayContaining(["price_options", "create_quote"]));
    expect(toolsForAgent("comms-customer").map((t) => t.name)).toEqual(expect.arrayContaining(["accept_quote", "send_quote"]));
  });

  it("no prompt or skill says answers are free or quotes are auto-approved", () => {
    for (const a of AGENT_NAMES) for (const re of FORBIDDEN) expect(system(a), `${a} ${re}`).not.toMatch(re);
    for (const s of loadAllSkills()) for (const re of FORBIDDEN) expect(s.content, `${s.slug} ${re}`).not.toMatch(re);
  });

  it("pricing: server prices the 1-3 options; the agent writes labels and notes and never a founder hold", () => {
    const p = system("pricing");
    expect(p).toMatch(/1-3 options/);
    expect(p).toMatch(/Keep the server's data items and numbers unchanged/);
    expect(p).toMatch(/Recommend the cheapest option that answers the question/);
    expect(p).toMatch(/never write a price of your own/);
    expect(p).not.toMatch(/estimate_costs|held for a founder|awaiting_approval/);
  });

  it("comms-customer: accepts the named option (recommended on a plain yes), sends changes back to pricing, never starts work unaccepted", () => {
    const c = system("comms-customer");
    expect(c).toMatch(/the recommended option on a plain yes/);
    expect(c).toMatch(/at most 300 characters, with no names, emails or phone numbers/);
    expect(c).toMatch(/so don't hand off after it/);
    expect(c).toMatch(/declines or asks for changes[\s\S]*terragent\.add_note[\s\S]*terragent\.handoff to pricing \(stage pricing\)/);
    expect(c).toMatch(/Never start work without an accepted option/);
  });

  it("acquisition: compares free, paid archive and tasking, and never orders before the customer accepts", () => {
    const q = system("acquisition");
    expect(q).toMatch(/terragent\.list_providers, then SkyWatch/);
    expect(q).toMatch(/tasking/);
    expect(q).toMatch(/Never prepare or place a paid order before the customer has accepted an option/);
    expect(q).toMatch(/terragent\.handoff to pricing \(stage pricing\)/);
    expect(q).toMatch(/Free sample \(is_free_sample\): free data only/);
    expect(q).toMatch(/to interpreter \(stage report\) when the saved plan's choice is existing_index/);
  });

  it("coordinator: quotes wait on the customer; a nudge only with new information", () => {
    const c = system("coordinator");
    expect(c).toMatch(/waiting_on_customer/);
    expect(c).toMatch(/Only when there is NEW information/);
    expect(c).toMatch(/never a plain reminder/);
    expect(c).toMatch(/never start work on a quote nobody accepted/);
  });

  it("coordinator: a dropped handoff follows the stuck list's hint, and paid data always goes through acquisition", () => {
    const c = system("coordinator");
    for (const reason of ["quote_not_sent", "clarifying_not_sent", "accepted_not_started", "data_delivered_not_started"]) expect(c).toContain(reason);
    expect(c).toMatch(/do exactly what that request's hint says, once/);
    expect(c).toMatch(/never approve, prepare or buy an order/);
    expect(c).toMatch(/stays waiting, on a digest too/);
  });

  it("acquisition: can prepare the orders of an accepted option when the acceptance never held them", () => {
    expect(system("acquisition")).toMatch(/no order was held[\s\S]*terragent\.prepare_paid_order/);
  });

  it.each(["acquisition", "pricing", "comms-customer", "coordinator"] as const)("%s: never writes a person's name or email into a brief", (a) => {
    expect(system(a)).toMatch(/name, email address or phone number/);
  });
});

/** Naïve parks our calls for approval and approving one does not run it: the model re-issues each approved call itself. */
describe("parked calls and handoff refusals", () => {
  const withHandoff = AGENT_NAMES.filter((a) => granted(a).has("terragent.handoff"));

  it.each(AGENT_NAMES)("%s: \"waiting for approval\" is not a failure, and approved calls are re-issued, saves first", (a) => {
    const p = system(a);
    expect(p).toContain('A result "terragent.<tool> is waiting for approval" is not a failure');
    expect(p).toMatch(/re-issue every approved call exactly as before[^.]*saves before the call that ends your turn/);
    expect(p).toMatch(/Never say a call ran unless its result came back/);
  });

  it("every agent with terragent.handoff calls it alone, as its last call", () => {
    expect(withHandoff).toEqual(expect.arrayContaining(["coordinator", "acquisition", "planner", "analytics", "interpreter"]));
    for (const a of withHandoff) expect(system(a), a).toContain("Call terragent.handoff alone");
  });

  it("pipeline agents do a step handoff names as missing, then hand off again (not a retry)", () => {
    for (const a of withHandoff.filter((x) => x !== "coordinator")) {
      expect(system(a), a).toMatch(/If terragent\.handoff refuses because a step is missing[\s\S]*does not count toward the one-retry limit/);
    }
  });

  it("interpreter: save_report_draft comes before check_report_rules (rules check a saved report_id)", () => {
    const p = system("interpreter");
    const save = p.indexOf("terragent.save_report_draft");
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(p.indexOf("terragent.check_report_rules"));
    expect(p).toMatch(/terragent\.handoff to verifier \(stage verification\), on its own/);
  });
});

describe("PRICING v2 playbook skills", () => {
  it.each(loadAllSkills().map((s) => [s.slug, s] as const))("%s: the Price section describes paid options accepted by the customer", (_slug, s) => {
    const price = priceSection(s.content);
    expect(price).toMatch(/Only the investigation \(planning and comparing sources\) is free/);
    expect(price).toMatch(/Every answer is paid/);
    expect(price).toMatch(/1-3 options/);
    expect(price).toMatch(/Nothing runs until the customer accepts one option/);
    expect(price).toMatch(/never below \$29/);
  });
});
