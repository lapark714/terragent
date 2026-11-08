-- Signals: NWS zone geometry cache. ~96% of NWS alerts carry no polygon, so their footprint is the convex hull
-- of their zones, and each zone GeoJSON is 50-700 KB. Zones change rarely (expirationDate 2200-01-01), so hulls
-- are kept indefinitely and survive cold starts (docs/platform/signals.md §4 #8).
CREATE TABLE IF NOT EXISTS nws_zone_cache (
  zone_url    text PRIMARY KEY,
  hull        jsonb NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT now()
);
