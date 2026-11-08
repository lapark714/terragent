/**
 * Monid REST wrapper (https://api.monid.ai, Bearer MONID_API_KEY). Discover/inspect/balance are free.
 * monidRun is the only way our code spends Monid money: allowlisted endpoints only, a per-call ceiling
 * checked against the live price card, a per-day ceiling summed from the spend table, and a spend row
 * plus an event for every run. The key never appears in errors, results or logs.
 */
import { CAPS } from "../config";
import { env } from "../env";
import { logEvent } from "../events";
import { USER_AGENT, errorMessage } from "../signals/http";
import { findAllowed, normalizeInput } from "./allowlist";
import { monidSpentTodayUsd, recordMonidSpend } from "./ledger";
import { cardPriceUsd, estimateCostUsd, reportedCostUsd } from "./price";
import type { MonidInput, MonidPrice, MonidRunBody } from "./types";

export { MONID_ALLOWLIST } from "./allowlist";
export { monidSpentTodayUsd } from "./ledger";

const BASE = "https://api.monid.ai";
const RUN_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_DEADLINE_MS = 90_000;
const INSPECT_TTL_MS = 3_600_000;
const TERMINAL = new Set(["COMPLETED", "FAILED", "BLOCKED", "STOPPED", "TIMED_OUT"]);

export interface MonidEndpoint {
  provider: string;
  endpoint: string;
  price_usd: number | null;
  description: string;
  name?: string;
  price?: MonidPrice;
  /** True if monidRun will accept it. */
  allowlisted?: boolean;
  health?: string | null;
}

export interface MonidRunResult {
  status: "COMPLETED" | "BLOCKED" | "FAILED" | "TIMED_OUT" | "REFUSED";
  output: unknown;
  cost_usd: number;
  run_id: string | null;
  reason?: string;
  /** Pre-flight worst-case estimate from the price card. */
  estimated_usd?: number;
}

export interface MonidInspection {
  provider: string;
  endpoint: string;
  description: string;
  method: string | null;
  price: MonidPrice | null;
  price_usd: number | null;
  input: Record<string, unknown> | null;
  notes: string[];
  allowlisted: boolean;
}

interface Reply {
  status: number;
  data: unknown;
  retryAfter: string | null;
}

async function call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<Reply> {
  const key = env("MONID_API_KEY");
  if (!key) throw new Error("MONID_API_KEY is not set");
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(errorMessage(err).split(key).join("***"));
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text.slice(0, 200) };
  }
  return { status: res.status, data, retryAfter: res.headers.get("retry-after") };
}

const messageOf = (r: Reply) => (r.data as { message?: string } | null)?.message ?? `HTTP ${r.status}`;

async function expectOk<T>(reply: Promise<Reply>, what: string): Promise<T> {
  const r = await reply;
  if (r.status >= 400) throw new Error(`Monid ${what} failed: ${r.status} ${messageOf(r)}`);
  return r.data as T;
}

// ---------------------------------------------------------------------------
// Free calls
// ---------------------------------------------------------------------------

interface DiscoverCard {
  provider: string;
  endpoint: string;
  displayName?: string;
  displayDescription?: string;
  price?: MonidPrice;
  metrics?: { status?: string };
}

export async function monidDiscover(q: string, limit = 5): Promise<MonidEndpoint[]> {
  const data = await expectOk<{ items?: DiscoverCard[] }>(
    call("POST", "/v1/discover/endpoints", { q, limit: Math.min(Math.max(1, limit), 50) }),
    "discover",
  );
  return (data.items ?? []).map((i) => ({
    provider: i.provider,
    endpoint: i.endpoint,
    name: i.displayName,
    description: i.displayDescription ?? "",
    price_usd: cardPriceUsd(i.price),
    price: i.price,
    allowlisted: !!findAllowed(i.provider, i.endpoint),
    health: i.metrics?.status ?? null,
  }));
}

const inspectCache = new Map<string, { at: number; value: MonidInspection }>();

/** Input schema + live price card. Cached for an hour (prices change rarely; runs re-check via this). */
export async function monidInspect(provider: string, endpoint: string): Promise<MonidInspection> {
  const cacheKey = `${provider} ${endpoint}`;
  const hit = inspectCache.get(cacheKey);
  if (hit && Date.now() - hit.at < INSPECT_TTL_MS) return hit.value;
  const d = await expectOk<{ description?: string; method?: string; price?: MonidPrice; input?: Record<string, unknown>; notes?: string[] }>(
    call("POST", "/v1/inspect", { provider, endpoint }),
    "inspect",
  );
  const value: MonidInspection = {
    provider,
    endpoint,
    description: d.description ?? "",
    method: d.method ?? null,
    price: d.price ?? null,
    price_usd: cardPriceUsd(d.price),
    input: d.input ?? null,
    notes: d.notes ?? [],
    allowlisted: !!findAllowed(provider, endpoint),
  };
  inspectCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function monidBalance(): Promise<{ balance_usd: number; held_usd: number }> {
  const d = await expectOk<{ balance?: { value: number }; held?: { value: number } }>(call("GET", "/v1/wallet/balance"), "balance");
  return { balance_usd: d.balance?.value ?? 0, held_usd: d.held?.value ?? 0 };
}

// ---------------------------------------------------------------------------
// Paid: monidRun
// ---------------------------------------------------------------------------

interface Outcome {
  result: MonidRunResult;
  /** What to book in the spend table; null when no run was created. */
  charge: { usd: number; estimate: boolean } | null;
}

const outcome = (status: MonidRunResult["status"], reason: string, run_id: string | null = null, charge: Outcome["charge"] = null): Outcome => ({
  result: { status, output: null, cost_usd: charge && !charge.estimate ? charge.usd : 0, run_id, reason },
  charge,
});

export async function monidRun(args: {
  provider: string;
  endpoint: string;
  input: Record<string, unknown>;
  purpose: string;
  requestId?: string;
  agent?: string;
}): Promise<MonidRunResult> {
  const { provider, endpoint, purpose, requestId, agent } = args;
  const pre = await preflight(args);
  const { result, charge } = "refused" in pre ? outcome("REFUSED", pre.refused) : await execute(provider, endpoint, pre.input, pre.estimate);
  if (pre.estimate !== undefined) result.estimated_usd = pre.estimate;

  if (charge) {
    try {
      await recordMonidSpend({
        amountUsd: charge.usd,
        isEstimate: charge.estimate,
        agent,
        requestId,
        meta: { provider, endpoint, purpose, run_id: result.run_id, status: result.status },
      });
    } catch (err) {
      result.reason = [result.reason, `spend ledger write failed: ${errorMessage(err)}`].filter(Boolean).join("; ");
    }
  }
  // Audit trail for the dashboard; failing to write it must not hide a run that already happened.
  await logEvent(
    "monid.run",
    agent ?? "system",
    { provider, endpoint, purpose, status: result.status, cost_usd: result.cost_usd, estimated_usd: result.estimated_usd ?? null, run_id: result.run_id, reason: result.reason ?? null },
    requestId,
  ).catch(() => undefined);
  return result;
}

type Preflight = { refused: string; estimate?: number } | { input: MonidInput; estimate: number };

async function preflight(args: { provider: string; endpoint: string; input: Record<string, unknown> }): Promise<Preflight> {
  const entry = findAllowed(args.provider, args.endpoint);
  if (!entry) return { refused: `${args.provider} ${args.endpoint} is not on the Monid allowlist` };
  if (!env("MONID_API_KEY")) return { refused: "MONID_API_KEY is not set" };
  const { input, results } = normalizeInput(entry, args.input ?? {});

  let estimate: number | null;
  try {
    estimate = estimateCostUsd((await monidInspect(args.provider, args.endpoint)).price ?? undefined, input, results);
  } catch (err) {
    return { refused: `price check failed: ${errorMessage(err)}` };
  }
  if (estimate === null) return { refused: "the price card can't be estimated; not assuming it is free" };
  if (estimate > CAPS.monidMaxUsdPerCall) {
    return { refused: `estimated $${estimate} is over the per-call cap of $${CAPS.monidMaxUsdPerCall}`, estimate };
  }
  let spent: number;
  try {
    spent = await monidSpentTodayUsd();
  } catch (err) {
    return { refused: `spend ledger unavailable, so the daily cap can't be checked: ${errorMessage(err)}`, estimate };
  }
  if (spent + estimate > CAPS.monidMaxUsdPerDay) {
    return { refused: `daily Monid cap: $${spent.toFixed(4)} spent today + $${estimate} would pass $${CAPS.monidMaxUsdPerDay}`, estimate };
  }
  return { input, estimate };
}

async function execute(provider: string, endpoint: string, input: MonidInput, estimate: number): Promise<Outcome> {
  let reply: Reply;
  try {
    reply = await call("POST", "/v1/run", { provider, endpoint, input }, RUN_TIMEOUT_MS);
  } catch (err) {
    // The run may exist even though the response was lost: book the estimate so the daily cap stays honest.
    return outcome("FAILED", `no response from Monid (${errorMessage(err)}); the run may exist, check before retrying`, null, { usd: estimate, estimate: true });
  }
  if (reply.status === 402) return outcome("BLOCKED", "Monid wallet balance too low (402); a founder must top up");
  if (reply.status === 429) return outcome("FAILED", `rate limited by Monid; retry after ${reply.retryAfter ?? "a few"} s`);

  let run = reply.data as MonidRunBody | null;
  if (!run?.runId && reply.status >= 500) {
    // A 5xx (or a gateway 504 on a long sync run) doesn't prove the run wasn't created and billed.
    return outcome("FAILED", `Monid ${reply.status} ${messageOf(reply)}; the run may exist, check before retrying`, null, { usd: estimate, estimate: true });
  }
  if (!run?.runId) return outcome("FAILED", `run rejected: ${reply.status} ${messageOf(reply)}`);
  const polled = reply.status === 202 || !TERMINAL.has(run.status);
  if (polled) run = await poll(run);
  if (run.status === "COMPLETED" && reportedCostUsd(run.billing) === null && run.cost === undefined) run = await refetch(run);
  return fromRun(run, polled ? null : reply.status, estimate);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function refetch(run: MonidRunBody): Promise<MonidRunBody> {
  try {
    const r = await call("GET", `/v1/runs/${encodeURIComponent(run.runId)}`);
    const body = r.data as MonidRunBody | null;
    return r.status < 400 && body?.status ? { ...run, ...body } : run;
  } catch {
    return run;
  }
}

/** Polls an async run until it is terminal or the deadline passes (then returns the last state seen). */
async function poll(run: MonidRunBody): Promise<MonidRunBody> {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let last = run;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    last = await refetch(last); // a 429 or blip while polling must not trigger a re-run
    if (TERMINAL.has(last.status)) return last;
  }
  return last;
}

function fromRun(run: MonidRunBody, httpStatus: number | null, estimate: number): Outcome {
  const id = run.runId;
  const reported = reportedCostUsd(run.billing) ?? run.cost?.value ?? null;
  const notBilled = { usd: reported ?? 0, estimate: false };
  switch (run.status) {
    case "COMPLETED": {
      const providerStatus = run.providerResponse?.httpStatus ?? httpStatus ?? 200;
      if (providerStatus >= 400) return outcome("FAILED", `provider returned HTTP ${providerStatus} (not billed)`, id, notBilled);
      const charge = reported === null ? { usd: estimate, estimate: true } : { usd: reported, estimate: false };
      return { result: { status: "COMPLETED", output: run.output ?? null, cost_usd: charge.usd, run_id: id }, charge };
    }
    case "BLOCKED": {
      const controls = (run.controls ?? []).map((c) => c.controlType).filter(Boolean).join(", ");
      return outcome("BLOCKED", `blocked by Monid workspace controls${controls ? ` (${controls})` : ""}: ${run.reason ?? "no reason given"}`, id, notBilled);
    }
    case "TIMED_OUT":
      return outcome("TIMED_OUT", "Monid run exceeded its time budget (not billed)", id, notBilled);
    case "FAILED":
    case "STOPPED":
      return outcome("FAILED", `Monid run ${run.status.toLowerCase()}${run.reason ? `: ${run.reason}` : ""}`, id, notBilled);
    default:
      return outcome("TIMED_OUT", `still ${run.status} after ${POLL_DEADLINE_MS / 1000} s (run ${id}); it may still be charged`, id, { usd: estimate, estimate: true });
  }
}
