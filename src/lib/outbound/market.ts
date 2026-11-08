/** Market researcher: cited prices of today's alternatives (site visits, inspections, compliance checks), spec §6/§10.8. */
import { z } from "zod";
import { getDb } from "../db/client";
import { Playbook } from "../domain";
import { logEvent } from "../events";
import { newId } from "../ids";
import { fail } from "./errors";

export const MarketPriceRow = z
  .object({
    playbook: Playbook,
    alternative: z.string().min(3).max(200).describe('what buyers do today, e.g. "drone roof inspection"'),
    price_low: z.number().nonnegative().nullable(),
    price_high: z.number().nonnegative().nullable(),
    unit: z.string().min(2).max(60).describe("per site | per report | per km2 | per month | per hour"),
    turnaround: z.string().max(100).nullable().optional(),
    source_title: z.string().min(3).max(300),
    source_url: z.url({ protocol: /^https?$/ }).describe("public page the price was read from (http/https)"),
    retrieved_at: z.iso.date().describe("YYYY-MM-DD the page was read"),
    notes: z.string().max(1000).nullable().optional(),
  })
  .refine((r) => r.price_low !== null || r.price_high !== null, { message: "give price_low, price_high or both" })
  .refine((r) => r.price_low === null || r.price_high === null || r.price_low <= r.price_high, { message: "price_low must be ≤ price_high" })
  .refine((r) => r.retrieved_at <= new Date(Date.now() + 86_400_000).toISOString().slice(0, 10), { message: "retrieved_at is in the future" });
export type MarketPriceRow = z.infer<typeof MarketPriceRow>;

/** Validates every row first (all-or-nothing), then upserts on (playbook, alternative, source_url). */
export async function saveMarketPrices(a: { rows: unknown[]; actor: string }) {
  const rows: MarketPriceRow[] = [];
  const errors: string[] = [];
  a.rows.forEach((raw, i) => {
    const p = MarketPriceRow.safeParse(raw);
    if (p.success) rows.push(p.data);
    else errors.push(`row ${i}: ${p.error.issues.map((x) => `${x.path.join(".") || "row"} ${x.message}`).join(", ")}`);
  });
  if (errors.length) fail(`nothing saved; fix these rows: ${errors.join("; ")}`);
  const db = await getDb();
  const saved: { id: string; inserted: boolean }[] = [];
  for (const r of rows) {
    const [row] = await db.query<{ id: string; inserted: boolean }>(
      `INSERT INTO market_prices (id, playbook, alternative, price_low, price_high, unit, turnaround, source_title, source_url, retrieved_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (playbook, alternative, source_url) DO UPDATE SET price_low = EXCLUDED.price_low, price_high = EXCLUDED.price_high,
         unit = EXCLUDED.unit, turnaround = EXCLUDED.turnaround, source_title = EXCLUDED.source_title,
         retrieved_at = EXCLUDED.retrieved_at, notes = EXCLUDED.notes
       RETURNING id, (xmax = 0) AS inserted`,
      [newId("marketPrice"), r.playbook, r.alternative, r.price_low, r.price_high, r.unit, r.turnaround ?? null, r.source_title, r.source_url,
        r.retrieved_at, r.notes ?? null],
    );
    saved.push(row);
  }
  const inserted = saved.filter((s) => s.inserted).length;
  await logEvent("market.prices_saved", a.actor, { inserted, updated: saved.length - inserted });
  return { saved: saved.length, inserted, updated: saved.length - inserted, ids: saved.map((s) => s.id) };
}
