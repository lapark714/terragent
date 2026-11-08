-- Outbound module: signal triage, prospect lookups, outreach touch counting, market price upserts.

-- Why a signal was matched or ignored (sourcing agent, update_signal).
ALTER TABLE signals ADD COLUMN IF NOT EXISTS status_reason text;
ALTER TABLE signals ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE INDEX IF NOT EXISTS signals_status_idx ON signals (playbook, status, created_at DESC);

-- One prospect per business per playbook (dedupe by domain, else company name).
CREATE INDEX IF NOT EXISTS prospects_domain_idx ON prospects (playbook, lower(domain));
CREATE INDEX IF NOT EXISTS prospects_company_idx ON prospects (playbook, lower(company));

-- Touch history per prospect (first touch, follow-ups, replies) and the free sample behind it.
CREATE INDEX IF NOT EXISTS messages_prospect_idx ON messages (prospect_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_prospect_idx ON requests (prospect_id);

-- New derived values near an asset since a given time (follow-ups).
CREATE INDEX IF NOT EXISTS earth_index_cell_created_idx ON earth_index (h3_cell, created_at DESC);

-- save_market_prices upserts one row per (playbook, alternative, source).
CREATE UNIQUE INDEX IF NOT EXISTS market_prices_key_idx ON market_prices (playbook, alternative, source_url);
