-- Core module: provider price currency + notes, and the agent-session ledger used for lanes and spend.

-- UP42 prices are in EUR (100 credits = 1 EUR); SkyWatch and Planet in USD. Columns keep their *_usd_ names.
ALTER TABLE providers ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE providers ADD COLUMN IF NOT EXISTS notes text;

-- One row per Naïve session we started (inbound lane) or learned about (webhooks), so spend and
-- stop reasons map back to a request and an agent.
CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id   text PRIMARY KEY,               -- ses_…
  agent        text NOT NULL,
  request_id   text,
  stage        text,
  lane         text NOT NULL DEFAULT 'inbound', -- inbound | background
  stop_reason  text,                           -- last session.idle stop_reason
  cost_usd     numeric(12,6),                  -- last known Naïve cost of the session
  started_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_sessions_request_idx ON agent_sessions (request_id);
