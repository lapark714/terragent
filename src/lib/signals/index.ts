/**
 * OWNER: signals builder. Free signal feeds normalised to SignalInput (docs/platform/signals.md).
 * One file per feed; this module dispatches, validates, dedupes, ranks and turns feed errors into warnings.
 */
import { SignalInput, type Playbook, type SignalFeed } from "../domain";
import { fetchBlmClaims } from "./blm-claims";
import { carryForwardIds, CLUSTERED_FEEDS } from "./continuity";
import { fetchFirms } from "./firms";
import { fetchGfw } from "./gfw";
import { errorMessage } from "./http";
import { fetchMrds } from "./mrds";
import { fetchNews } from "./news";
import { fetchNwpsFloods } from "./nwps-flood";
import { fetchNws } from "./nws";
import { fetchOpenFema } from "./openfema";
import { severityRank, type FeedFetcher, type FeedOptions, type FeedResult } from "./types";
import { fetchUsgsQuakes } from "./usgs-quake";

export type { FeedOptions, FeedResult, Severity } from "./types";
export { FOREST_WATCH_REGIONS } from "./regions";

export const FEEDS_BY_PLAYBOOK: Record<Exclude<Playbook, "inbound">, SignalFeed[]> = {
  disasters: ["nws", "usgs_quake", "nwps_flood", "firms", "openfema"],
  deforestation: ["gfw", "firms"],
  // blm_claims is the "what's new" feed (free, no key). mrds answers only region queries (bbox) and news is the
  // paid Monid feed (allowPaid), so a plain free poll gets its mining signals from blm_claims.
  mining: ["blm_claims", "mrds", "news"],
};

const FETCHERS: Record<SignalFeed, FeedFetcher> = {
  nws: fetchNws,
  usgs_quake: fetchUsgsQuakes,
  nwps_flood: fetchNwpsFloods,
  firms: fetchFirms,
  openfema: fetchOpenFema,
  gfw: fetchGfw,
  mrds: fetchMrds,
  news: fetchNews,
  blm_claims: fetchBlmClaims,
};

export const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/**
 * Fetch recent events from one feed. Feeds missing a key return [] and a warning, never throw.
 * Results are validated, deduped on external_id, and ranked most severe → most recent. Clustered feeds
 * (firms, gfw) first reuse the id of a nearby recently stored signal, so an ongoing event keeps one id.
 * `since` applies to event feeds; nws and nwps_flood report what is active now (dedupe happens on
 * (feed, external_id) when stored). `news` is paid and runs only with `allowPaid: true`.
 */
export async function pollFeed(feed: SignalFeed, opts: FeedOptions = {}): Promise<{ signals: SignalInput[]; warnings: string[] }> {
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  let res: FeedResult;
  try {
    res = await FETCHERS[feed]({ ...opts, limit });
  } catch (err) {
    return { signals: [], warnings: [`${feed}: ${errorMessage(err)}`] };
  }
  const warnings = res.warnings.map((w) => `${feed}: ${w}`);
  let valid: SignalInput[] = [];
  for (const s of res.signals) {
    const parsed = SignalInput.safeParse(s);
    if (parsed.success) valid.push(parsed.data);
    else warnings.push(`${feed}: dropped ${s.external_id}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  if (CLUSTERED_FEEDS.has(feed)) {
    try {
      valid = await carryForwardIds(feed, valid);
    } catch (err) {
      warnings.push(`${feed}: continuity check skipped, ongoing events may get new ids: ${errorMessage(err)}`);
    }
  }
  const seen = new Set<string>();
  valid = valid.filter((s) => !seen.has(s.external_id) && seen.add(s.external_id));
  valid.sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || (b.event_time ?? "").localeCompare(a.event_time ?? ""));
  return { signals: valid.slice(0, limit), warnings };
}

/** Poll every feed of a playbook in parallel (firms gets the playbook so it picks its regions). */
export async function pollPlaybook(playbook: Exclude<Playbook, "inbound">, opts: FeedOptions = {}) {
  const feeds = FEEDS_BY_PLAYBOOK[playbook];
  const results = await Promise.all(feeds.map((feed) => pollFeed(feed, { ...opts, playbook })));
  return {
    signals: results.flatMap((r) => r.signals),
    warnings: results.flatMap((r) => r.warnings),
    counts: Object.fromEntries(feeds.map((f, i) => [f, results[i].signals.length])) as Partial<Record<SignalFeed, number>>,
  };
}
