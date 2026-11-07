-- Terragent schema v2: runtime plumbing decided after platform research (see docs/ARCHITECTURE.md).

-- Key/value settings: Naïve agent ids, inbox "armed" flags, allocation snapshot, feature flags.
CREATE TABLE IF NOT EXISTS settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text NOT NULL DEFAULT 'system',
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One bearer token per agent for the Terragent MCP server. Raw token lives only in the Naïve vault.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash  text PRIMARY KEY,               -- sha256 hex of the bearer token
  agent       text NOT NULL,                  -- AgentName
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked     boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mcp_tokens_agent_idx ON mcp_tokens (agent);

-- Webhook dedupe (Naïve evt_ ids, AgentMail svix ids). Insert-or-skip before processing.
CREATE TABLE IF NOT EXISTS webhook_events (
  id           text PRIMARY KEY,              -- "<source>:<event id>"
  source       text NOT NULL,                 -- naive | agentmail
  type         text NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error        text
);

-- Requests: inbound work runs on the fast lane (direct sessions); background work goes through the board.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS priority text NOT NULL DEFAULT 'inbound'; -- inbound | background
ALTER TABLE requests ADD COLUMN IF NOT EXISTS acquisition_plan jsonb;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS quote_id text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS report_id text;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS stage text;               -- current pipeline stage name
ALTER TABLE requests ADD COLUMN IF NOT EXISTS card_id text;             -- Naïve board card mirroring this request
ALTER TABLE requests ADD COLUMN IF NOT EXISTS revisions integer NOT NULL DEFAULT 0;

-- Analyses: the Python pipeline's AnalysisResult per run (images are Naïve file ids).
CREATE TABLE IF NOT EXISTS analyses (
  id          text PRIMARY KEY,
  request_id  text NOT NULL,
  recipe      text NOT NULL,
  result      jsonb NOT NULL,
  file_ids    jsonb NOT NULL DEFAULT '{}',     -- { "<image path>": "fil_…" }
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS analyses_request_idx ON analyses (request_id, created_at DESC);

-- Outreach channels (NOTES 2026-11-07): contact_form | email_warm | email_direct | email (customer/supplier mail).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS counterpart_url text;      -- contact form URL for channel=contact_form
ALTER TABLE messages ADD COLUMN IF NOT EXISTS kind text;                 -- customer | supplier_quote | outreach | followup
ALTER TABLE messages ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE messages ALTER COLUMN counterpart_email DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_idem_idx ON messages (idempotency_key);

-- Prospects: which channel reached them and the contact form we found.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS channel text;             -- contact_form | email_warm | email_direct
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_form_url text;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS warm boolean NOT NULL DEFAULT false;
