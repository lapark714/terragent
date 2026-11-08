/**
 * Live smoke test of the Naïve integration with a throwaway agent, "tg-smoke" ($0.50/day cap):
 *   config        save-time validation of our exact config shape (SkyWatch MCP + tool names, integer
 *                 budgets, browser options, deny list, output_schema), plus probes Naïve should refuse;
 *   session       a session on the cheapest model: bash (creates the computer) + a SkyWatch MCP call +
 *                 submit_output → structured_output, then scripts/naive-probe-computer.ts on that computer;
 *   board         a keyed "doing" card (our inbound mirror) must not wake anyone;
 *   vision        view_image on a small uploaded PNG, on Sonnet (the interpreter's model) then Haiku;
 *   roundtrip     every real agent config saved on tg-smoke must read back with no changedFields (so a
 *                 second provisioning run is a no-op), $0;
 *   board-limits  (not in the default set) two extra members, tg-smoke-a/b: does a doing mirror card make
 *                 its assignee busy, and does re-assigning reset wake_count (naive/smoke-board.ts), ≈ $0.
 * Each session starts at the smallest budget Naïve accepts (refused creates are free), which also
 * measures the per-model pre-flight minimum. Stops if spend passes $1.50. Deletes the PNG and the
 * agents at the end unless --keep.
 *
 *   npx tsx scripts/naive-smoke.ts [--only config,session,board,vision,roundtrip,board-limits] [--keep] [--out findings.json]
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";
import { ApiError, type AgentCreate, type AgentPatch, type VettaClient } from "@usenaive-sdk/managed-agents";
import { usd } from "../src/lib/config";
import { AGENT_NAMES, outputSchema, ReportDraft } from "../src/lib/domain";
import { naive } from "../src/lib/naive/client";
import { allow, browserTools, DATA, neverTools, WEB } from "../naive/agents/tools";
import { buildAgentConfig, SKYWATCH_MCP, skywatchToolConfigs } from "../naive/index";
import { canon, changedFields } from "../naive/provision";
import { RunSummary } from "../naive/schemas";
import { BoardProbe, memberConfig, PROBE_MEMBERS, probeRoster } from "../naive/smoke-board";

const STEPS = ["config", "session", "board", "vision", "roundtrip", "board-limits"] as const;
type Step = (typeof STEPS)[number];
const DEFAULT_STEPS: readonly Step[] = ["config", "session", "board", "vision", "roundtrip"];

const { values } = parseArgs({
  options: { keep: { type: "boolean", default: false }, only: { type: "string" }, out: { type: "string" } },
});
const steps = new Set<Step>(values.only ? (values.only.split(",").map((x) => x.trim()) as Step[]) : DEFAULT_STEPS);
const unknownSteps = [...steps].filter((x) => !STEPS.includes(x));
if (unknownSteps.length) throw new Error(`--only: unknown step(s) ${unknownSteps.join(", ")}; expected ${STEPS.join("|")}`);

const NAME = "tg-smoke";
const CHEAP_MODEL = "zai-org/GLM-5.2-FP8"; // first (cheapest) in GET /v1/models on 2026-11-07; serves immediate too
const VISION_MODELS = ["anthropic/claude-sonnet-5.5", "anthropic/claude-haiku-5.5"];
const BUDGET_STEPS_USD = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5];
const SPEND_LIMIT_USD = 1.5;
/** Save-time validation accepts unreachable MCP servers (docs/platform/naive-live.md §3), so a fake origin is fine. */
const ROUNDTRIP_BASE = "https://terragent-roundtrip.example.com";

type Agent = Awaited<ReturnType<VettaClient["agents"]["get"]>>;
type Session = Awaited<ReturnType<VettaClient["sessions"]["get"]>>;
type NaiveEvent = Awaited<ReturnType<VettaClient["sessions"]["events"]>>["data"][number];
type SessionBody = Omit<Parameters<VettaClient["sessions"]["create"]>[0], "agent_id" | "budget_micro_usd">;

const client = naive();
const findings: Record<string, unknown> = { started_at: new Date().toISOString() };
const startBalance = (await client.credits.show()).balance_micro_usd;

const errText = (e: unknown) =>
  e instanceof ApiError ? `${e.status} ${e.code}${e.param ? ` param=${e.param}` : ""}: ${e.message}` : (e as Error).message;

async function spentUsd() {
  return (startBalance - (await client.credits.show()).balance_micro_usd) / 1e6;
}

function smokeConfig(): AgentCreate {
  return {
    name: NAME,
    description: "Throwaway smoke-test agent (scripts/naive-smoke.ts). Safe to delete.",
    model: CHEAP_MODEL,
    window: "immediate",
    harness: "pi",
    system: "You are a test agent. Follow the numbered steps in the user's message exactly, use only the tools named there, and keep replies short.",
    // The per-task ceiling is also checked against the pre-flight quote, so it equals the cap here.
    budget: { cap_micro_usd: usd(0.5), max_task_micro_usd: usd(0.5), period: "day" },
    tools: {
      default_config: { permission: "deny" },
      configs: { ...neverTools(), ...skywatchToolConfigs(), ...WEB, ...DATA, ...browserTools({ contactFormsApproved: true }), bash: allow(), view_image: allow() },
    },
    mcp_servers: [{ ...SKYWATCH_MCP }],
    skills: [],
    handoffs: false,
    output_schema: outputSchema(RunSummary),
    structured_output_required: false,
    metadata: { app: "terragent", purpose: "smoke" },
  };
}

function asPatch(config: AgentCreate): AgentPatch {
  const patch: AgentPatch & { name?: string } = { ...config };
  delete patch.name; // name and harness are create-only
  delete patch.harness;
  return patch;
}

async function waitIdle(id: string, timeoutMs = 300_000): Promise<Session> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const s = await client.sessions.get(id);
    if (s.status !== "running" && s.status !== "queued") return s;
    if (Date.now() > deadline) {
      await client.sessions.interrupt(id).catch(() => undefined);
      return client.sessions.get(id);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function eventSummary(id: string) {
  const events: NaiveEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.sessions.events(id, { after_seq: after, limit: 100 });
    events.push(...page.data);
    if (!page.has_more || !page.data.length) break;
    after = page.data[page.data.length - 1].seq;
  }
  const pick = (type: string) => events.filter((e) => e.type === type).map((e) => e.data);
  return {
    tools_started: pick("tool.started").map((d) => d.name),
    tool_errors: pick("tool.completed").filter((d) => d.is_error).map((d) => ({ name: d.name, output: String(d.output).slice(0, 400) })),
    degraded: pick("session.degraded"),
    budget_exceeded: pick("budget.exceeded"),
    idle: pick("session.idle").map((d) => ({ stop_reason: d.stop_reason, code: d.code, error: d.error })),
    model_calls: pick("span.model_request.end").map((d) => ({ model: d.resolved_model ?? d.model, tokens: d.token_usage, usd: Number(d.consumed_micro_usd ?? 0) / 1e6 })),
    last_reply: String(pick("message.completed").filter((d) => d.role !== "user").at(-1)?.content ?? "").slice(0, 600),
  };
}

/**
 * Naïve refuses a session at create (402 budget_exceeded, "below the pre-flight quote") when its budget
 * cannot cover one model call's reservation. Step the budget up until accepted: refused creates are free,
 * and the accepted value is the smallest workable session budget for that model and context.
 */
async function runSession(label: string, agent: Agent, body: SessionBody) {
  const spent = await spentUsd();
  console.log(`[smoke] spent so far $${spent.toFixed(4)} (before ${label})`);
  if (spent > SPEND_LIMIT_USD) throw new Error(`spend $${spent} passed the $${SPEND_LIMIT_USD} smoke limit; stopping`);
  const refused: number[] = [];
  let created: Session | undefined;
  let budgetUsd = 0;
  for (const b of BUDGET_STEPS_USD) {
    try {
      created = await client.sessions.create({ agent_id: agent.id, ...body, budget_micro_usd: usd(b) });
      budgetUsd = b;
      break;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "budget_exceeded")) throw e;
      refused.push(b);
    }
  }
  if (!created) {
    findings[label] = { model: agent.model, refused_budgets_usd: refused, error: "every budget step was below the pre-flight quote" };
    return;
  }
  const done = await waitIdle(created.id);
  const result = {
    session_id: done.id,
    model: agent.model,
    accepted_budget_usd: budgetUsd,
    refused_budgets_usd: refused,
    status: done.status,
    stop_reason: done.stop_reason,
    stop_code: done.stop_code ?? null,
    structured_output: done.structured_output,
    consumed_usd: done.consumed_micro_usd / 1e6,
    token_usage: done.token_usage,
    computer_id: done.computer_id,
    ...(await eventSummary(done.id)),
  };
  findings[label] = result;
  console.log(`[smoke] ${label}: ${done.status}/${done.stop_reason} $${result.consumed_usd} tools=${result.tools_started.join(",")}`);
}

/** (a) Try config changes; record whether Naïve accepted each, then restore the real config. */
async function checkConfig(agent: Agent): Promise<Agent> {
  const probes: Record<string, unknown> = {};
  const base = smokeConfig();
  const configs = base.tools!.configs;
  const probe = async (label: string, expected: "accepted" | "refused", patch: AgentPatch) => {
    try {
      agent = await client.agents.update(agent.id, { ...patch, expected_version: agent.current_version });
      probes[label] = { expected, got: "accepted", version: agent.current_version, stored_mcp_servers: agent.mcp_servers };
    } catch (e) {
      probes[label] = { expected, got: "refused", error: errText(e) };
    }
  };
  await probe("unknown_mcp_tool_name", "refused", { tools: { ...base.tools!, configs: { ...configs, "skywatch.no_such_tool": allow() } } });
  await probe("mcp_server_type_field", "refused", { mcp_servers: [{ ...SKYWATCH_MCP, type: "url" } as unknown as { name: string; url: string }] });
  await probe("declared_server_without_tools", "refused", { mcp_servers: [{ ...SKYWATCH_MCP }, { name: "spare", url: SKYWATCH_MCP.url }] });
  await probe("server_without_mcp_behind_it", "refused", {
    mcp_servers: [{ ...SKYWATCH_MCP }, { name: "example", url: "https://example.com/mcp" }],
    tools: { ...base.tools!, configs: { ...configs, "example.get_request": allow() } },
  });
  await probe("float_budget", "refused", { budget: { cap_micro_usd: 500_000.5, max_task_micro_usd: 250_000, period: "day" } });
  await probe("secret_header_inline", "refused", { mcp_servers: [{ ...SKYWATCH_MCP, headers: { Authorization: "Bearer not-a-real-secret" } }] });
  await probe("non_secret_header", "accepted", { mcp_servers: [{ ...SKYWATCH_MCP, headers: { "x-terragent-agent": NAME } }] });
  await probe("report_draft_output_schema", "accepted", { output_schema: outputSchema(ReportDraft) });
  await probe("handoffs_team_without_roster", "refused", { handoffs: "team" });
  await probe("unknown_skill", "refused", { skills: ["playbook-does-not-exist"] });
  findings.save_probes = probes;
  return client.agents.update(agent.id, { ...asPatch(base), expected_version: agent.current_version });
}

/** (b) bash + MCP + structured output on the cheapest model, then probe the computer it created. */
async function checkSessionAndComputer(agent: Agent) {
  await runSession("session_bash_mcp_structured", agent, {
    message: [
      "Smoke test. Do exactly these steps and nothing else:",
      "1. Run this bash command: echo smoke-ok && python3 --version && df -h ~ | tail -1",
      '2. Call skywatch.get_offerings with {"category": "archive", "limit": 3}.',
      '3. Call submit_output with outcome "done", request_id null, next_agent null, and summary = the bash output plus the names of the offerings (or the error you got).',
    ].join("\n"),
    metadata: { purpose: "smoke", step: "b" },
  });
  try {
    const out = execFileSync("npx", ["tsx", "scripts/naive-probe-computer.ts", "--agent", NAME, "--json"], { encoding: "utf8", timeout: 600_000 });
    findings.computer_probe = JSON.parse(out);
  } catch (e) {
    findings.computer_probe = { error: (e as Error).message.slice(0, 1000) };
  }
}

/** (c) A keyed "doing" card with an assignee must not start a session. Returns true if one was woken (and cancelled). */
async function checkBoard(agent: Agent): Promise<boolean> {
  try {
    const board = await client.board.create(agent.id);
    const card = await client.board.cards.create(agent.id, { key: "smoke:mirror", title: "Smoke mirror card", body: "Visible; must not wake anyone.", status: "doing", assignee: NAME });
    const again = await client.board.cards.create(agent.id, { key: "smoke:mirror", title: "Smoke mirror card (replay)", body: "ignored", status: "todo", assignee: NAME });
    const woken = card.woken_session_id ?? again.woken_session_id;
    if (woken) await client.sessions.cancel(woken).catch(() => undefined);
    const done = await client.board.cards.update(agent.id, card.id, { status: "done", note: "smoke test finished" });
    findings.board = {
      board_id: board.id,
      card: { id: card.id, status: card.status, assignee: card.assignee, woken_session_id: card.woken_session_id },
      keyed_replay: { same_id: again.id === card.id, title: again.title, body_ignored: again.body !== "ignored", status: again.status },
      after_done: { status: done.status, note: done.note, woken_session_id: done.woken_session_id },
    };
    return Boolean(woken);
  } catch (e) {
    findings.board = { error: errText(e) };
    return false;
  }
}

/** A width×height RGB PNG: left half green, right half yellow (the file name must not give this away). */
function twoColourPng(width = 256, height = 128): Buffer {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(x < width / 2 ? [20, 160, 40] : [240, 210, 20], y * row + 1 + x * 3);
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]); // type + data; CRC covers both
    const out = Buffer.alloc(4 + body.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), 4 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit, truecolor, deflate, no filter, no interlace
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** (d) view_image on an uploaded PNG with a per-session, required output_schema. Returns the file id. */
async function checkVision(agent: Agent, models: string[]): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(twoColourPng())], { type: "image/png" }), "tg-smoke-probe.png");
  form.append("tags", "smoke");
  const file = await client.files.upload(form);
  findings.png = { id: file.id, content_type: file.content_type, size_bytes: file.size_bytes, kind: file.kind };
  for (const model of models) {
    agent = await client.agents.update(agent.id, { model, expected_version: agent.current_version });
    await runSession(`session_view_image_${model.split("/")[1]}`, agent, {
      message:
        `Call view_image with file_ids ["${file.id}"]. The image has a left half and a right half. Then call submit_output with the colour ` +
        "of each half (one word each) and saw_pixels = true only if the picture itself reached you (false if you only got text).",
      output_schema: {
        type: "object",
        properties: { left_color: { type: "string" }, right_color: { type: "string" }, saw_pixels: { type: "boolean" } },
        required: ["left_color", "right_color", "saw_pixels"],
        additionalProperties: false,
      },
      structured_output_required: true,
      metadata: { purpose: "smoke", step: "vision" },
    });
  }
  return file.id;
}

/**
 * Save each real agent config on tg-smoke (skills dropped: they are not pushed to the org yet) and read
 * it back: changedFields must be empty, or every provisioning run would mint new versions.
 */
async function checkRoundTrip(agent: Agent): Promise<Agent> {
  const out: Record<string, { after_update: string[]; after_get: string[] }> = {};
  const roundTrip = async (label: string, want: AgentCreate) => {
    agent = await client.agents.update(agent.id, { ...asPatch(want), expected_version: agent.current_version });
    const fresh = await client.agents.get(agent.id);
    out[label] = { after_update: changedFields(agent, want), after_get: changedFields(fresh, want) };
  };
  await roundTrip(NAME, smokeConfig());
  for (const name of AGENT_NAMES) await roundTrip(name, { ...buildAgentConfig(name, { publicBaseUrl: ROUNDTRIP_BASE }), name: NAME, skills: [] });
  findings.roundtrip = out;
  const drifted = Object.entries(out).filter(([, r]) => r.after_update.length || r.after_get.length);
  console.log(`[smoke] roundtrip: ${drifted.length ? `DRIFT in ${drifted.map(([k, r]) => `${k}(${[...new Set([...r.after_update, ...r.after_get])].join(",")})`).join(" ")}` : "no drift"}`);
  return client.agents.update(agent.id, { ...asPatch(smokeConfig()), expected_version: agent.current_version });
}

/** Owner = tg-smoke on the cheapest session model (board digests start owner sessions); members tg-smoke-a/b. */
async function checkBoardLimits(owner: Agent): Promise<Agent[]> {
  const members: Agent[] = [];
  const all = (await client.agents.list({ limit: 100 })).data;
  for (const name of PROBE_MEMBERS) {
    const found = all.find((a) => a.name === name);
    members.push(found ? await client.agents.update(found.id, { ...asPatch(memberConfig(name)), expected_version: found.current_version }) : await client.agents.create(memberConfig(name)));
  }
  const roster = probeRoster(members);
  owner = await client.agents.update(owner.id, { ...asPatch(memberConfig(NAME)), multiagent: roster, expected_version: owner.current_version });
  findings.team_roundtrip = { multiagent_equal: canon(owner.multiagent) === canon(roster), stored: owner.multiagent, handoffs: owner.handoffs };
  await client.board.create(owner.id);
  const probe = new BoardProbe(client, owner, (l) => console.log(l));
  try {
    findings.board_busy_unassigned_mirror = await probe.busy(PROBE_MEMBERS[0], false);
    findings.board_busy = await probe.busy(PROBE_MEMBERS[1], true);
    findings.board_wakes = await probe.wakes(PROBE_MEMBERS);
  } catch (e) {
    findings.board_limits_error = errText(e);
  }
  // Owner digests and late member wakes the probe set off: cancel any still running, and list them all.
  const sessions: Record<string, { id: string; status: string; stop_reason: string | null; usd: number }[]> = {};
  for (const a of [owner, ...members]) {
    const rows = (await client.sessions.list({ agent_id: a.id, limit: 50 })).data;
    for (const x of rows) if (x.status === "running" || x.status === "queued") await client.sessions.cancel(x.id).catch(() => undefined);
    sessions[a.name] = rows.map((x) => ({ id: x.id, status: x.status, stop_reason: x.stop_reason, usd: x.consumed_micro_usd / 1e6 }));
  }
  findings.board_limits_sessions = { cancelled_on_wake: probe.cancelled, by_agent: sessions };
  return members;
}

let agent: Agent | undefined;
let extraAgents: Agent[] = [];
let fileId: string | undefined;
try {
  const existing = (await client.agents.list({ limit: 100 })).data.find((a) => a.name === NAME);
  agent = existing
    ? await client.agents.update(existing.id, { ...asPatch(smokeConfig()), expected_version: existing.current_version })
    : await client.agents.create(smokeConfig());
  findings.agent = {
    id: agent.id,
    version: agent.current_version,
    harness: agent.harness,
    budget: agent.budget,
    mcp_servers: agent.mcp_servers,
    tool_count: Object.keys(agent.tools.configs).length,
    browser_config: agent.tools.configs.browser?.config ?? null,
    output_schema_top_keys: Object.keys(agent.output_schema ?? {}),
  };
  console.log(`[smoke] saved ${agent.id} v${agent.current_version}`);

  let boardWoke = false;
  if (steps.has("config")) agent = await checkConfig(agent);
  if (steps.has("roundtrip")) agent = await checkRoundTrip(agent);
  if (steps.has("session")) await checkSessionAndComputer(agent);
  if (steps.has("board")) boardWoke = await checkBoard(agent);
  // A woken board session already used the third session slot: then only the interpreter's model.
  if (steps.has("vision")) fileId = await checkVision(agent, boardWoke || !steps.has("session") ? VISION_MODELS.slice(0, 1) : VISION_MODELS);
  if (steps.has("board-limits")) extraAgents = await checkBoardLimits(agent);
  findings.agent_spend = await client.agents.spend(agent.id, { by: "component" }).catch((e) => ({ error: errText(e) }));
} catch (e) {
  findings.fatal = errText(e);
  process.exitCode = 1;
} finally {
  findings.spent_usd = await spentUsd();
  if (!values.keep) {
    const cleanup: Record<string, string> = {};
    if (fileId) cleanup.file = await client.files.delete(fileId).then(() => "deleted", errText);
    for (const a of [...extraAgents, ...(agent ? [agent] : [])]) {
      cleanup[a.name] = await client.agents.delete(a.id).then(() => "deleted (with its computer and deployments)", errText);
    }
    findings.cleanup = cleanup;
  }
  findings.finished_at = new Date().toISOString();
  const json = JSON.stringify(findings, null, 2);
  if (values.out) writeFileSync(values.out, json);
  console.log(json);
}
