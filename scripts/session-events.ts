/**
 * Dump a Naïve session's event log (no deltas). READ-ONLY.
 *
 *   npx tsx scripts/session-events.ts <ses_…> [--accepted] [--raw] [--full] [--types=a,b] [--approvals]
 *
 *   --accepted   include_accepted=true: also list the opt-in rows the API hides by default — message.accepted,
 *                handoff.sent, tool.confirm.resolved (who allowed/denied a parked call, with scope), tool.confirm.answered,
 *                session.mode, plan.updated, outcome.evaluation.*
 *   --raw        read GET /v1/sessions/{id}/events with fetch instead of the SDK, so rows of a type the SDK has no
 *                schema for are shown instead of being skipped (the SDK reports them only as `skipped`)
 *   --full       print each row's JSON in full (default: first 330 chars)
 *   --types=…    only print rows whose type is in the comma-separated list
 *   --approvals  (implies --accepted) one line per parked batch: the order we confirmed the calls in, and whether the
 *                model re-issued each one afterwards. Naïve's allow does NOT run a parked call: the model must re-issue
 *                it with byte-identical args (tool_call_id `tc_…` is a hash of name + args), so an allowed call that
 *                is never re-issued never ran.
 */
import "dotenv/config";
import { getNaive, naiveBaseUrl } from "../src/lib/naive/client";
import { requireEnv } from "../src/lib/env";

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith("--"));
if (!id) {
  console.error("usage: npx tsx scripts/session-events.ts <ses_…> [--accepted] [--raw] [--full] [--types=a,b] [--approvals]");
  process.exit(1);
}
const approvals = args.includes("--approvals");
const accepted = approvals || args.includes("--accepted");
const raw = args.includes("--raw");
const full = args.includes("--full");
const types = args.find((a) => a.startsWith("--types="))?.slice("--types=".length).split(",").filter(Boolean);

type Row = { seq: number; type: string; created_at?: string; data?: Record<string, unknown> } & Record<string, unknown>;
type Page = { data: Row[]; has_more?: boolean; skipped?: number };

async function rawPage(after: number): Promise<Page> {
  const q = new URLSearchParams({ after_seq: String(after), limit: "100", ...(accepted ? { include_accepted: "true" } : {}) });
  const res = await fetch(`${naiveBaseUrl()}/v1/sessions/${encodeURIComponent(id!)}/events?${q}`, {
    headers: { authorization: `Bearer ${requireEnv("NAIVE_API_KEY")}`, "vetta-version": "2026-09-30" },
  });
  if (!res.ok) throw new Error(`events ${res.status}: ${await res.text()}`);
  return (await res.json()) as Page;
}

const client = raw ? null : await getNaive();
const rows: Row[] = [];
let after = 0;
let skipped = 0;
for (;;) {
  const page: Page = client
    ? ((await client.sessions.events(id, { after_seq: after, limit: 100, includeAccepted: accepted })) as unknown as Page)
    : await rawPage(after);
  skipped += Number(page.skipped ?? 0);
  if (!page.data.length) break;
  rows.push(...page.data);
  after = Math.max(after, ...page.data.map((e) => Number(e.seq)));
  if (page.has_more === false || page.data.length < 100) break;
}

/** Key order differs between tool.confirm and tool.started args, so compare a canonical form. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]`
  : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`
  : JSON.stringify(v);

if (approvals) {
  type Parked = { tc: string; name: string; args: string; turn: number; readPeople: boolean; resolved?: number; how?: string; reissued?: number; reparked?: boolean };
  const parked: Parked[] = [];
  let turn = 0;
  for (const e of rows) {
    const d = e.data ?? {};
    if (e.type === "session.running") turn++;
    else if (e.type === "tool.confirm") {
      for (const p of parked) if (p.tc === d.tool_call_id && p.reissued) p.reparked = true;
      parked.push({ tc: String(d.tool_call_id), name: String(d.name), args: canon(d.args), turn, readPeople: d.read_people === true });
    } else if (e.type === "tool.confirm.resolved") {
      const p = parked.find((x) => x.tc === d.tool_call_id && x.resolved === undefined);
      if (p) { p.resolved = e.seq; p.how = `${String(d.decision)}/${String(d.scope)}`; }
    } else if (e.type === "tool.started") {
      const a = canon(d.args);
      const p = parked.find((x) => x.name === d.name && x.args === a && x.how?.startsWith("allow") && !x.reissued && x.turn < turn);
      if (p) p.reissued = e.seq;
    }
  }
  const turns = [...new Set(parked.map((p) => p.turn))];
  for (const t of turns) {
    const batch = parked.filter((p) => p.turn === t).sort((a, b) => (a.resolved ?? Infinity) - (b.resolved ?? Infinity));
    const lost = batch.filter((p) => p.how?.startsWith("allow") && !p.reissued);
    console.log(`batch of ${batch.length} (confirm order):`, batch.map((p) =>
      `${p.name}${p.readPeople ? "[read_people]" : ""} ${p.how ?? "unanswered"}@${p.resolved ?? "-"} → ${p.reissued ? `re-issued@${p.reissued}` : p.how?.startsWith("allow") ? "NEVER RE-ISSUED" : "-"}${p.reparked ? " (identical call parked again later)" : ""}`).join(" | "),
      lost.length ? `  WARNING: ${lost.length} allowed call(s) never ran` : "");
  }
  if (!parked.length) console.log("no parked calls");
} else {
  for (const e of rows) {
    const { seq, type, created_at, ...rest } = e;
    if (types && !types.includes(String(type))) continue;
    const json = JSON.stringify(rest);
    console.log(seq, type, String(created_at ?? "").slice(11, 19), full ? json : json.slice(0, 330));
  }
}
if (skipped) console.log(`(${skipped} row(s) of types this SDK build has no schema for were skipped; rerun with --raw)`);
process.exit(0);
