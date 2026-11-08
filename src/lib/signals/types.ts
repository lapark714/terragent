import type { BBox, Playbook, SignalInput } from "../domain";

export interface FeedOptions {
  /** Only events at or after this time (event feeds). Current-state feeds (nws, nwps_flood) ignore it. */
  since?: Date;
  /** Max signals returned (most severe, then most recent, first). */
  limit?: number;
  /** firms: "deforestation" polls the forest watch regions instead of the US. news: playbook to tag. */
  playbook?: Playbook;
  /** Region query for firms, gfw and mrds. */
  bbox?: BBox;
  /** news only: allow the paid Monid call. Off by default. */
  allowPaid?: boolean;
  /** news only: topic override. */
  query?: string;
  /** Attribution for paid calls (spend ledger). */
  agent?: string;
  requestId?: string;
}

export interface FeedResult {
  signals: SignalInput[];
  warnings: string[];
}

export type FeedFetcher = (opts: FeedOptions) => Promise<FeedResult>;

/** One severity scale across feeds (feed-native values stay in `raw`). */
export const SEVERITIES = ["extreme", "severe", "moderate", "minor"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Higher = more severe; unknown/null = 0. */
export function severityRank(s: string | null): number {
  const i = SEVERITIES.indexOf(s as Severity);
  return i < 0 ? 0 : SEVERITIES.length - i;
}

export const DAY_MS = 86_400_000;

export const daysAgo = (days: number) => new Date(Date.now() - days * DAY_MS);

export const truncate = (s: string | null | undefined, max: number) =>
  s == null ? null : s.length > max ? `${s.slice(0, max - 1)}…` : s;

/** ISO-8601 week label, e.g. "2026-W45". Used to keep cluster ids stable within a week. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day); // Thursday of this week decides the year
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / DAY_MS + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const isoDate = (d: Date) => d.toISOString().slice(0, 10);

/** ISO timestamp, or null for a missing or unparseable value (one bad row must not sink a whole feed). */
export function isoTime(value: string | number | null | undefined): string | null {
  if (value == null || value === "") return null;
  const t = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
