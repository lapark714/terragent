/** Durable layer of the NWS zone hull cache (table nws_zone_cache); nws.ts keeps an in-memory layer on top. */
import { getDb } from "../db/client";
import type { LonLat } from "./geometry";

export async function readZoneHulls(urls: string[]): Promise<Map<string, LonLat[]>> {
  if (!urls.length) return new Map();
  const db = await getDb();
  const rows = await db.query<{ zone_url: string; hull: LonLat[] }>("SELECT zone_url, hull FROM nws_zone_cache WHERE zone_url = ANY($1)", [urls]);
  return new Map(rows.map((r) => [r.zone_url, r.hull]));
}

export async function writeZoneHulls(hulls: Map<string, LonLat[]>): Promise<void> {
  if (!hulls.size) return;
  const db = await getDb();
  await db.query(
    `INSERT INTO nws_zone_cache (zone_url, hull)
     SELECT u, h::jsonb FROM unnest($1::text[], $2::text[]) AS t(u, h)
     ON CONFLICT (zone_url) DO UPDATE SET hull = EXCLUDED.hull, fetched_at = now()`,
    [[...hulls.keys()], [...hulls.values()].map((h) => JSON.stringify(h))],
  );
}
