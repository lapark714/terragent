/** Provider & data-type registry reads (rows seeded by db/seeds/providers.ts). */
import type { DataType } from "../domain";
import { num, query, queryOne } from "./db";

export interface ProviderRow {
  id: string; name: string; vendor: string; data_type: DataType; resolution_m: string | number | null; revisit_days: string | number | null;
  coverage: string | null; is_free: boolean; pricing_model: string | null; currency: string;
  archive_usd_per_km2: string | number | null; tasking_usd_per_km2: string | number | null; min_order_km2: string | number | null;
  delivery_time: string | null; license_terms: string | null; access_method: string; access_url: string | null; quote_contact: string | null;
  notes: string | null; citations: { url: string; retrieved_at?: string; note?: string }[]; active: boolean;
}

export async function getProvider(id: string): Promise<ProviderRow | null> {
  return queryOne<ProviderRow>("SELECT * FROM providers WHERE id = $1", [id]);
}

export async function listProviders(f: { data_type?: DataType; free_only?: boolean; max_resolution_m?: number } = {}) {
  const rows = await query<ProviderRow>(
    `SELECT * FROM providers WHERE active
       AND ($1::text IS NULL OR data_type = $1)
       AND (NOT $2 OR is_free)
       AND ($3::numeric IS NULL OR resolution_m <= $3)
     ORDER BY is_free DESC, data_type, resolution_m DESC NULLS LAST`,
    [f.data_type ?? null, f.free_only ?? false, f.max_resolution_m ?? null],
  );
  return rows.map(providerView);
}

/** Compact, number-typed view for agents. Prices are per km² in `currency` (EUR for UP42). */
export function providerView(p: ProviderRow) {
  return {
    id: p.id, name: p.name, vendor: p.vendor, data_type: p.data_type, resolution_m: num(p.resolution_m), revisit_days: num(p.revisit_days),
    coverage: p.coverage, is_free: p.is_free, pricing_model: p.pricing_model, currency: p.currency,
    archive_per_km2: num(p.archive_usd_per_km2), tasking_per_km2: num(p.tasking_usd_per_km2), min_order_km2: num(p.min_order_km2),
    delivery_time: p.delivery_time, license_terms: p.license_terms, access_method: p.access_method, access_url: p.access_url,
    quote_contact: p.quote_contact, notes: p.notes, sources: (p.citations ?? []).map((c) => c.url),
  };
}

export const isEmail = (s: string | null | undefined): s is string => !!s && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
