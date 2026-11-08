-- Pricing v2 (NOTES 2026-11-08): a quote offers 1–3 options; nothing beyond the free investigation runs until the
-- customer ACCEPTS one (accept_quote, or the accept link /quote/<accept_token>). Idempotent: safe to re-run.
-- data_cost_usd / analysis_cost_usd / margin_usd / price_usd stay and mirror the recommended option (the accepted
-- one once accepted; a range option mirrors its low end) so the dashboard keeps working.

ALTER TABLE quotes ADD COLUMN IF NOT EXISTS options jsonb NOT NULL DEFAULT '[]';  -- QuoteOption[] (src/lib/domain.ts)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS recommended_option_id text;           -- A | B | C
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_option_id text;              -- set once, by acceptQuote (pipeline/acceptance.ts)
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accepted_at timestamptz;
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS accept_token text;                    -- opaque, for the accept link
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS valid_until timestamptz;              -- created_at + 7 days
CREATE UNIQUE INDEX IF NOT EXISTS quotes_accept_token_idx ON quotes (accept_token);
