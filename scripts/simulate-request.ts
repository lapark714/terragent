/**
 * Usage: tsx scripts/simulate-request.ts [--offline]
 *
 * Deterministic local end-to-end of the inbound free-data path (spec §3.2, DoD 1) with NO LLM and NO sends:
 * in-memory database, TERRAGENT_LANES=off (handoffs are recorded, no Naïve sessions or cards), and no Naïve /
 * AgentMail keys in the environment, so the final delivery is expected to come back "blocked".
 * Every agent step goes through runTool() — the same allowlist, validation and handlers the MCP server uses.
 * --offline replaces the two imagery calls (scene search, local pipeline) with fixtures; without it they run for
 * real and the script stops with a clear message at the first module that is still a stub.
 */
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentName, AnalysisResult, ReportDraft, Verdict } from "../src/lib/domain";

process.env.TERRAGENT_DB = "memory";
process.env.TERRAGENT_LANES = "off";
for (const k of ["DATABASE_URL", "AGENTMAIL_API_KEY", "TEAM_EMAILS", "NAIVE_API_KEY", "VETTA_API_KEY"]) delete process.env[k];

// Imported after the environment is locked down.
const { runTool } = await import("../src/lib/mcp/server");
const { startInboundRequest } = await import("../src/lib/pipeline/requests");
const { SITE, sampleAnalysis, samplePlan, sampleSpec, setupMemoryDb } = await import("../src/lib/pipeline/testing");
const { runPipelineLocally } = await import("../src/lib/imagery/local-pipeline");

const offline = process.argv.includes("--offline");
const t0 = Date.now();
const log = (msg: string) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);

class Stop extends Error {}

/** One agent tool call; stops the run on an error result. */
async function call<T = Record<string, unknown>>(agent: AgentName, tool: string, args: Record<string, unknown>): Promise<T> {
  const res = (await runTool(tool, args, { agent })) as T & { error?: string };
  if (res && typeof res === "object" && "error" in res) {
    const stub = /not implemented yet/.test(String(res.error));
    throw new Stop(`${agent} → ${tool}: ${res.error}${stub ? "\n  A dependency is still a stub. Re-run with --offline to use imagery fixtures." : ""}`);
  }
  log(`${agent.padEnd(15)} ${tool}`);
  return res;
}

async function stage<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Stop) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new Stop(`${label}: ${msg}${/not implemented yet/.test(msg) ? "\n  A dependency is still a stub. Re-run with --offline to use imagery fixtures." : ""}`);
  }
}

const sceneDate = (s: AnalysisResult["before"]) => s?.datetime.slice(0, 10) ?? null;

type AnalysisView = Omit<AnalysisResult, "images"> & { images: (AnalysisResult["images"][number] & { file_id: string | null })[] };

/** What a deterministic Brain 2 would write from the analysis alone. */
function templateDraft(requestId: string, r: AnalysisView): ReportDraft {
  const main = r.indices.find((i) => i.delta !== null) ?? r.indices[0];
  const answer = main
    ? `Between ${sceneDate(r.before)} and ${sceneDate(r.after)}, mean ${main.name.toUpperCase()} changed by ${main.delta} (from ${main.before_mean} to ${main.after_mean}).` +
      (main.affected_area_km2 !== null ? ` About ${main.affected_area_km2} km² crossed the threshold (${main.threshold}).` : "") +
      " This is a simulated report written from a template."
    : "No clear scene was found for the requested dates, so no measurement could be made. This is a simulated report.";
  return {
    request_id: requestId, title: `Simulated ${r.recipe.replace(/_/g, " ")} report`, answer, confidence: (r.after?.clear_fraction ?? 0) >= 0.9 ? "medium" : "low",
    measurements: r.indices.map((i) => ({ metric: i.name, value: i.delta ?? i.after_mean, unit: i.unit, before: i.before_mean, after: i.after_mean, note: i.threshold })),
    images: r.images.map((img) => ({
      role: img.role, url: img.file_id ?? img.path, caption: img.caption,
      date: sceneDate(img.role === "before" ? r.before : r.after),
      source: img.role === "before" || img.role === "after" ? "Sentinel-2 L2A (Copernicus)" : "Terragent analysis of Sentinel-2",
    })),
    sources: [r.before, r.after].filter((s) => s !== null).map((s) => ({
      name: "Sentinel-2 L2A", collection: s.collection, item_id: s.item_id, datetime: s.datetime, url: null, license: "Copernicus Sentinel data licence",
    })),
    limitations: "10 m pixels can't resolve single structures; thresholds are indicative and vary by land cover; one clear scene per date.",
    human_review_recommended: false, paid_data_estimate: null,
  };
}

/** Closed in the finally below: PGlite keeps a 10 s internal timer alive, which would hold the process open after the run. */
const opened: { db: Awaited<ReturnType<typeof setupMemoryDb>> | null } = { db: null };

async function main() {
  const db = (opened.db = await setupMemoryDb());
  log(`memory database ready (${offline ? "offline fixtures" : "live imagery calls"})`);

  const req = await startInboundRequest({
    question: "Did the January 2025 Eaton fire burn the area around our Altadena site?", location_text: SITE.text,
    lat: SITE.lat, lon: SITE.lon, email: "simulator@example.com", name: "Simulator", source: "portal",
  });
  log(`portal request ${req.id} created → ${req.status}, owner ${req.owner_agent}`);
  const id = req.id;

  // 1 · Comms 2 screens and hands to Brain 1.
  await call("comms-customer", "record_screening", { request_id: id, allowed: true, category: "ok", reason: "Property burn check for a business site" });
  await call("comms-customer", "handoff", { request_id: id, to: "planner", stage: "planning", instructions: "Build the data spec" });

  // 2 · Brain 1: Earth index first, then the spec (lat/lon came with the request, so no geocoding).
  await call("planner", "earth_index_lookup", { request_id: id });
  await call("planner", "save_data_spec", sampleSpec(id));
  await call("planner", "handoff", { request_id: id, to: "acquisition", stage: "acquisition", instructions: "Free first" });

  // 3 · Orchestrator: free scenes, compare paid, log both decisions, save the plan.
  const freePlan = samplePlan(id);
  if (!offline) {
    const scenes = await call<{ provider_id: string; before: unknown; after: unknown; notes: string[] }>("acquisition", "search_free_scenes", { request_id: id });
    freePlan.free_option = { provider_id: scenes.provider_id, before_scene: scenes.before as never, after_scene: scenes.after as never, sufficient: !!scenes.after, why: scenes.notes.join("; ") || "clear scenes found" };
  }
  const { providers } = await call<{ providers: { id: string; archive_per_km2: number | null; min_order_km2: number | null }[] }>("acquisition", "list_providers", { data_type: "optical" });
  const paid = providers.find((p) => p.id === "sw-vantor-30cm");
  const alt = { option: "sw-vantor-30cm archive", cost_usd: paid?.archive_per_km2 ? paid.archive_per_km2 * 4 : null, why_not: "10 m free imagery answers a burn-scar question" };
  await call("acquisition", "log_decision", { request_id: id, kind: "source_selection", choice: freePlan.free_option!.provider_id, reasoning: "Newest clear Sentinel-2 pair around the fire dates", alternatives: [alt] });
  await call("acquisition", "log_decision", { request_id: id, kind: "free_vs_paid", choice: "free", reasoning: "A neighbourhood-scale burn is visible at 10 m; paid sub-metre data adds cost without changing the answer", alternatives: [alt] });
  await call("acquisition", "save_acquisition_plan", freePlan);
  await call("acquisition", "handoff", { request_id: id, to: "pricing", stage: "pricing", instructions: "Quote the free-data report" });

  // 4 · Pricing.
  await call("pricing", "estimate_costs", { request_id: id });
  const { quote } = await call<{ quote: { id: string; price_usd: number; auto_approved: boolean } }>("pricing", "create_quote", { request_id: id });
  log(`quote ${quote.id}: $${quote.price_usd} (${quote.auto_approved ? "auto-approved" : "needs a founder"})`);
  await call("pricing", "handoff", { request_id: id, to: "analytics", stage: "analysis", instructions: "Run the pipeline" });

  // 5 · Analytics: job → pipeline (locally) → publish (fake file ids) → save.
  const { job } = await call<{ job: Parameters<typeof runPipelineLocally>[0] }>("analytics", "get_analysis_job", { request_id: id });
  const outDir = path.join(os.tmpdir(), "terragent-sim", id);
  await mkdir(outDir, { recursive: true });
  const result = offline ? sampleAnalysis() : await stage("runPipelineLocally", () => runPipelineLocally(job, outDir));
  log(`pipeline ${offline ? "fixture" : `ran into ${outDir}`}: ${result.indices.length} indices, ${result.images.length} images, ${result.h3_metrics.length} cell metrics`);
  const fileIds = Object.fromEntries(result.images.map((img, i) => [img.path, `fil_local${i + 1}`]));
  await call("analytics", "save_analysis", { request_id: id, result, file_ids: fileIds });
  await call("analytics", "handoff", { request_id: id, to: "interpreter", stage: "report", instructions: "Write the report" });

  // 6 · Brain 2: template report, rule pre-check, hand to the Verifier.
  const analysis = await call<{ result: AnalysisView }>("interpreter", "get_analysis", { request_id: id });
  const draft = await call<{ report_id: string; url: string }>("interpreter", "save_report_draft", templateDraft(id, analysis.result));
  await call("interpreter", "check_report_rules", { report_id: draft.report_id });
  await call("interpreter", "handoff", { request_id: id, to: "verifier", stage: "verification", instructions: "Grade the report" });

  // 7 · Verifier: accept what the rules accept.
  const rules = await call<{ checks: { id: Verdict["checks"][number]["id"]; pass: boolean; note: string }[]; hard_failures: string[]; score: number }>("verifier", "check_report_rules", { report_id: draft.report_id });
  const pass = rules.hard_failures.length === 0;
  await call("verifier", "save_verdict", {
    report_id: draft.report_id, pass, score: rules.score, checks: rules.checks.map(({ id: cid, pass: p, note }) => ({ id: cid, pass: p, note })),
    required_fixes: pass ? [] : rules.hard_failures,
  });

  // 8 · Comms 2 delivers (blocked: inboxes are not armed in a fresh database).
  const delivery = await call<{ status: string; blocked_reason: string | null }>("comms-customer", "deliver_report", { request_id: id });
  log(`delivery: ${delivery.status}${delivery.blocked_reason ? ` (${delivery.blocked_reason})` : ""}`);

  const [final] = await db.query<{ status: string; owner_agent: string }>("SELECT status, owner_agent FROM requests WHERE id = $1", [id]);
  const [{ n }] = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM earth_index WHERE request_id = $1", [id]);
  const timeline = await db.query<{ type: string; actor: string; payload: Record<string, unknown> }>(
    "SELECT type, actor, payload FROM events WHERE request_id = $1 AND type <> 'tool.called' ORDER BY id", [id]);
  console.log("\nTimeline:");
  for (const e of timeline) console.log(`  ${e.actor.padEnd(16)} ${e.type.padEnd(24)} ${summary(e.payload)}`);
  console.log(`\nRequest ${id}: ${final.status} (owner ${final.owner_agent}); ${n} Earth index rows`);
  console.log(`Report: ${new URL(draft.url).pathname}`);
  console.log(delivery.status === "blocked" ? "Delivery blocked as expected: no inbox is armed and no AgentMail key is loaded." : `Delivery status: ${delivery.status}`);
}

function summary(p: Record<string, unknown>): string {
  const keys = ["to", "stage", "from", "note", "choice", "kind", "recipe", "price_usd", "report_id", "status", "blocked_reason"];
  return keys.filter((k) => p[k] !== undefined && p[k] !== null).map((k) => `${k}=${String(p[k]).slice(0, 60)}`).join(" ");
}

try {
  await main();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(`\nStopped: ${e.message}`);
  process.exitCode = 2;
} finally {
  await opened.db?.close();
}
