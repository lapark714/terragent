/**
 * Mining news via Monid (akta /v1/news). PAID (~$0.01 per poll at 10 articles), so it runs only when the
 * caller passes allowPaid; every call goes through monidRun's allowlist, caps and spend ledger.
 */
import type { Playbook, SignalInput } from "../domain";
import { monidRun } from "../monid/client";
import { daysAgo, isoDate, isoTime, truncate, type FeedOptions, type FeedResult } from "./types";

const DEFAULT_QUERY: Partial<Record<Playbook, string>> = {
  mining: "mineral exploration drilling results, new mining claims and mine expansion",
};

interface AktaArticle {
  id: string;
  title: string;
  url?: string;
  publisher?: string;
  published_date?: string;
  sentiment?: string;
  ai_summary?: string;
  newsworthiness_score?: number;
  group_id?: string;
  countries?: string[];
  tags?: { name: string }[];
  company_mentions?: { name: string; website?: string | null; is_primary?: boolean }[];
  entities?: { location?: string[] };
}

export async function fetchNews(opts: FeedOptions): Promise<FeedResult> {
  if (!opts.allowPaid) {
    return { signals: [], warnings: ["paid feed (Monid akta /v1/news, ~$0.01/poll); pass allowPaid to enable"] };
  }
  const playbook = opts.playbook && opts.playbook !== "inbound" ? opts.playbook : "mining";
  const query = opts.query ?? DEFAULT_QUERY[playbook] ?? playbook;
  const run = await monidRun({
    provider: "akta",
    endpoint: "/v1/news",
    input: { queryParams: { query, limit: Math.min(opts.limit ?? 10, 10), start_date: isoDate(opts.since ?? daysAgo(7)), group_articles: true } },
    purpose: `${playbook} news signals`,
    agent: opts.agent,
    requestId: opts.requestId,
  });
  if (run.status !== "COMPLETED") return { signals: [], warnings: [`Monid ${run.status}: ${run.reason ?? "no reason"}`] };
  const articles = ((run.output as { data?: AktaArticle[] } | null)?.data ?? []).filter((a) => a.id && a.title);
  return { signals: articles.map((a) => toSignal(a, playbook, run.cost_usd / Math.max(articles.length, 1))), warnings: [] };
}

function toSignal(a: AktaArticle, playbook: Playbook, costShare: number): SignalInput {
  return {
    playbook,
    feed: "news",
    external_id: a.group_id ? `group:${a.group_id}` : a.id,
    title: truncate(a.title, 200)!,
    severity: null,
    event_time: isoTime(a.published_date),
    geometry: null,
    lat: null,
    lon: null,
    raw: {
      article_id: a.id,
      url: a.url ?? null,
      publisher: a.publisher ?? null,
      published_date: a.published_date ?? null,
      summary: truncate(a.ai_summary, 800),
      sentiment: a.sentiment ?? null,
      newsworthiness: a.newsworthiness_score ?? null,
      countries: a.countries ?? [],
      locations: a.entities?.location ?? [],
      companies: (a.company_mentions ?? []).map((c) => ({ name: c.name, website: c.website ?? null, primary: !!c.is_primary })),
      tags: (a.tags ?? []).map((t) => t.name),
      source: "akta via Monid",
      cost_usd: Number(costShare.toFixed(6)),
    },
  };
}
