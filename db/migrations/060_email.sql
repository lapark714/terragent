-- Email module: opt-out tokens, send bookkeeping, Agent Armor verdicts, template kinds, routing indexes.

-- Opaque opt-out tokens: /unsubscribe?t=<token>. One stable token per address so old links keep working.
CREATE TABLE IF NOT EXISTS optout_tokens (
  token       text PRIMARY KEY,
  email       text NOT NULL UNIQUE,            -- lowercase
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);

-- Suppression: when the address reached AgentMail's send block list (opt-out / manual); NULL = retry on next suppress.
ALTER TABLE suppression ADD COLUMN IF NOT EXISTS blocklisted_at timestamptz;

-- messages.status gains: sending | failed (alongside draft | blocked | sent | received | bounced).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_at timestamptz;              -- set when a send is attempted; daily cap counts by this
ALTER TABLE messages ADD COLUMN IF NOT EXISTS security_verdict text;            -- pending | clear | review | unavailable (inbound, Agent Armor)
ALTER TABLE messages ADD COLUMN IF NOT EXISTS security_reason text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS meta jsonb NOT NULL DEFAULT '{}'; -- routing outcome, ignore reasons, recipients
CREATE INDEX IF NOT EXISTS messages_sent_at_idx      ON messages (sent_at) WHERE sent_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_counterpart_idx  ON messages (counterpart_email, direction, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_agentmail_id_idx ON messages (agentmail_message_id);

-- Templates: outreach (first touch) or followup (new information). Both need founder approval.
ALTER TABLE templates ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'outreach';

-- Inbound routing looks threads up on these.
CREATE INDEX IF NOT EXISTS requests_thread_idx           ON requests (thread_id);
CREATE INDEX IF NOT EXISTS prospects_outreach_thread_idx ON prospects (outreach_thread_id);
CREATE INDEX IF NOT EXISTS orders_quote_thread_idx       ON orders (quote_thread_id);
