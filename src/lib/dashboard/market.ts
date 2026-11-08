/**
 * "What it costs today" (spec §6, §10.8): the market researcher's cited prices for what buyers do now instead of
 * asking us (site visits, drone inspections, compliance audits), next to our own floor price. Read-only; the
 * researcher writes `market_prices` through save_market_prices (src/lib/outbound/market.ts).
 */
import { PRICING } from "../config";
import { getDb } from "../db/client";
import { PLAYBOOKS } from "../domain";
import { asPlaybook } from "./board";
import { numOrNull } from "./rows";
import type { MarketPrices } from "./types";

/** Enough for a slide: a handful of alternatives per playbook, each with its sources. */
const MAX_ROWS = 60;

/** Only plain web links are rendered as links (rows are validated on write; this is the belt to that brace). */
const httpUrl = (v: string | null) => (v && /^https?:\/\/[^\s]+$/i.test(v) ? v : null);

export async function getMarketPrices(): Promise<MarketPrices> {
  const db = await getDb();
  const rows = await db.query<{
    id: string; playbook: string; alternative: string; price_low: unknown; price_high: unknown; unit: string;
    turnaround: string | null; source_title: string; source_url: string; retrieved_at: string;
  }>(
    `SELECT id, playbook, alternative, price_low, price_high, unit, turnaround, source_title, source_url,
            to_char(retrieved_at, 'YYYY-MM-DD') AS retrieved_at
     FROM market_prices
     ORDER BY array_position($1::text[], playbook), alternative, retrieved_at DESC, id
     LIMIT ${MAX_ROWS}`,
    [[...PLAYBOOKS]],
  );
  return {
    ourFromUsd: PRICING.minReportUsd,
    rows: rows.map((r) => ({
      id: r.id,
      playbook: asPlaybook(r.playbook),
      alternative: r.alternative.slice(0, 200),
      low: numOrNull(r.price_low),
      high: numOrNull(r.price_high),
      unit: r.unit.slice(0, 60),
      turnaround: r.turnaround ? r.turnaround.slice(0, 100) : null,
      sourceTitle: r.source_title.slice(0, 300),
      sourceUrl: httpUrl(r.source_url),
      retrievedAt: r.retrieved_at,
    })),
  };
}
