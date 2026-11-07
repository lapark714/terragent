-- Terragent schema v1.
-- Plain SQL so the same file runs on Neon (prod) and PGlite (local/tests).
-- H3 cells are computed in application code (h3-js / python h3) and stored as text.
-- IDs are app-generated, prefixed strings (req_…, rpt_…) so agents and humans can read them.

-- ---------------------------------------------------------------------------
-- Requests: every unit of work (inbound ask, free sample for a prospect, monitor re-check)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS requests (
  id               text PRIMARY KEY,
  source           text NOT NULL,              -- portal | email | api | signal | monitor
  playbook         text NOT NULL DEFAULT 'inbound', -- disasters | deforestation | mining | inbound
  status           text NOT NULL DEFAULT 'received',
  owner_agent      text,                       -- which agent currently owns it (board view)
  customer_email   text,
  customer_name    text,
  company          text,
  question         text NOT NULL,
  location_text    text,
  lat              double precision,
  lon              double precision,
  aoi              jsonb,                      -- GeoJSON geometry of the area of interest
  h3_cells         text[] NOT NULL DEFAULT '{}',
  data_spec        jsonb,                      -- Brain 1 output (DataSpec)
  is_free_sample   boolean NOT NULL DEFAULT false,
  prospect_id      text,
  monitor_id       text,
  thread_id        text,                       -- AgentMail thread for this request
  inbox            text,                       -- hello | data | outreach
  naive_session_ids text[] NOT NULL DEFAULT '{}',
  cost_usd         numeric(12,4) NOT NULL DEFAULT 0,  -- real cost so far (spend tracking)
  price_usd        numeric(12,2),                     -- what we charge (null = free)
  refusal_reason   text,
  meta             jsonb NOT NULL DEFAULT '{}',
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS requests_status_idx   ON requests (status);
CREATE INDEX IF NOT EXISTS requests_playbook_idx ON requests (playbook);
CREATE INDEX IF NOT EXISTS requests_created_idx  ON requests (created_at DESC);

-- ---------------------------------------------------------------------------
-- Event log: append-only timeline of everything that happens (feeds board + funnel)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id          bigserial PRIMARY KEY,
  request_id  text,
  type        text NOT NULL,                  -- e.g. request.created, status.changed, email.sent
  actor       text NOT NULL,                  -- agent name | 'human:<name>' | 'system'
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_request_idx ON events (request_id, created_at);
CREATE INDEX IF NOT EXISTS events_type_idx    ON events (type, created_at DESC);

-- ---------------------------------------------------------------------------
-- Decision log: source chosen, free vs paid, pricing, screening, verification, allocation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id            text PRIMARY KEY,
  request_id    text,
  kind          text NOT NULL,                -- source_selection | free_vs_paid | pricing | screening | verification | playbook_allocation | outreach | monitoring
  choice        text NOT NULL,
  reasoning     text NOT NULL,
  alternatives  jsonb NOT NULL DEFAULT '[]',  -- [{option, cost_usd, why_not}]
  agent         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_request_idx ON decisions (request_id);
CREATE INDEX IF NOT EXISTS decisions_kind_idx    ON decisions (kind, created_at DESC);

-- ---------------------------------------------------------------------------
-- Quotes (Pricing agent) and paid data orders (always held for founder approval)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotes (
  id                 text PRIMARY KEY,
  request_id         text NOT NULL,
  data_cost_usd      numeric(12,2) NOT NULL DEFAULT 0,
  analysis_cost_usd  numeric(12,2) NOT NULL DEFAULT 0,
  margin_usd         numeric(12,2) NOT NULL DEFAULT 0,
  price_usd          numeric(12,2) NOT NULL,
  auto_approved      boolean NOT NULL DEFAULT false,
  status             text NOT NULL DEFAULT 'draft', -- draft | needs_approval | sent | accepted | declined | expired
  line_items         jsonb NOT NULL DEFAULT '[]',
  payment_link       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quotes_request_idx ON quotes (request_id);

CREATE TABLE IF NOT EXISTS orders (
  id                 text PRIMARY KEY,
  request_id         text NOT NULL,
  provider_id        text NOT NULL,
  product            text NOT NULL,           -- e.g. "archive optical 0.5m"
  area_km2           numeric(12,3),
  est_cost_usd       numeric(12,2) NOT NULL,
  status             text NOT NULL DEFAULT 'awaiting_approval', -- awaiting_approval | approved | rejected | placed | delivered | cancelled
  justification      text NOT NULL,           -- why free data is not enough
  quote_thread_id    text,                    -- AgentMail thread on data@ with the supplier
  supplier_quote_usd numeric(12,2),           -- real quote, once a supplier replies
  approved_by        text,
  decided_at         timestamptz,
  meta               jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders (status);

-- ---------------------------------------------------------------------------
-- Reports (Brain 2 output, graded by the Verifier before delivery)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reports (
  id                        text PRIMARY KEY,
  request_id                text NOT NULL,
  title                     text NOT NULL,
  answer                    text NOT NULL,
  confidence                text NOT NULL,    -- high | medium | low
  measurements              jsonb NOT NULL DEFAULT '[]', -- [{metric, value, unit, before, after, delta}]
  images                    jsonb NOT NULL DEFAULT '[]', -- [{role: before|after|index, url, caption, date, source}]
  sources                   jsonb NOT NULL DEFAULT '[]', -- [{name, collection, item_id, datetime, url, license}]
  limitations               text NOT NULL,
  human_review_recommended  boolean NOT NULL DEFAULT false,
  paid_data_estimate        jsonb,            -- what paid data would add + estimated cost
  verifier_status           text NOT NULL DEFAULT 'pending', -- pending | pass | fail
  verifier_notes            text,
  verifier_score            numeric(5,2),
  revision                  integer NOT NULL DEFAULT 1,
  public_token              text NOT NULL,    -- unguessable token for the shareable report URL
  meta                      jsonb NOT NULL DEFAULT '{}',
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_request_idx ON reports (request_id);

-- ---------------------------------------------------------------------------
-- Earth index (the moat): DERIVED results only, keyed by H3 cell, date, metric, source.
-- Never raw purchased imagery.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS earth_index (
  id           bigserial PRIMARY KEY,
  h3_cell      text NOT NULL,
  h3_res       smallint NOT NULL,
  layer        text NOT NULL,                 -- disasters | forest | mining | inbound
  metric       text NOT NULL,                 -- ndvi_mean | mndwi_delta | dnbr_mean | iron_oxide_ratio | ...
  value        double precision NOT NULL,
  unit         text,
  observed_at  date NOT NULL,                 -- scene date of the measurement
  source       text NOT NULL,                 -- e.g. sentinel-2-l2a:S2B_MSIL2A_...
  change_flag  boolean NOT NULL DEFAULT false,
  report_id    text,
  request_id   text,
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS earth_index_cell_idx   ON earth_index (h3_cell, metric, observed_at DESC);
CREATE INDEX IF NOT EXISTS earth_index_layer_idx  ON earth_index (layer, created_at DESC);

-- ---------------------------------------------------------------------------
-- Provider & data-type registry: adding a data type is configuration, not architecture.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id                       text PRIMARY KEY,  -- e.g. pc-sentinel-2-l2a, up42-pleiades-neo
  name                     text NOT NULL,
  vendor                   text NOT NULL,
  data_type                text NOT NULL,     -- optical | radar | thermal | hyperspectral | elevation | alerts
  resolution_m             numeric(8,2),
  revisit_days             numeric(6,2),
  coverage                 text,
  is_free                  boolean NOT NULL DEFAULT false,
  pricing_model            text,              -- free | per_km2_archive | per_km2_tasking | subscription | quote
  archive_usd_per_km2      numeric(10,2),
  tasking_usd_per_km2      numeric(10,2),
  min_order_km2            numeric(10,2),
  delivery_time            text,
  license_terms            text,
  access_method            text NOT NULL,     -- stac | api | email_quote | web_form
  access_url               text,
  quote_contact            text,              -- email or form URL for quote requests
  citations                jsonb NOT NULL DEFAULT '[]', -- [{url, retrieved_at, note}]
  active                   boolean NOT NULL DEFAULT true,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Signal engine: signals → prospects → outreach
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS signals (
  id            text PRIMARY KEY,
  playbook      text NOT NULL,
  feed          text NOT NULL,                -- nws | usgs_quake | nwps_flood | firms | openfema | gfw | mrds | news
  external_id   text NOT NULL,
  title         text NOT NULL,
  severity      text,
  event_time    timestamptz,
  geometry      jsonb,
  lat           double precision,
  lon           double precision,
  h3_cells      text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'new',  -- new | matched | ignored
  raw           jsonb NOT NULL DEFAULT '{}',
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (feed, external_id)
);
CREATE INDEX IF NOT EXISTS signals_playbook_idx ON signals (playbook, created_at DESC);

CREATE TABLE IF NOT EXISTS prospects (
  id                 text PRIMARY KEY,
  signal_id          text,
  playbook           text NOT NULL,
  company            text NOT NULL,
  domain             text,
  contact_name       text,
  contact_email      text,
  contact_role       text,
  asset_description  text,
  asset_lat          double precision,
  asset_lon          double precision,
  score_fit          numeric(4,3),
  score_urgency      numeric(4,3),
  score_ability      numeric(4,3),
  score_reach        numeric(4,3),
  score_total        numeric(6,4),
  status             text NOT NULL DEFAULT 'matched', -- matched | sample_requested | sample_ready | emailed | replied | quoted | paid | opted_out | disqualified
  sample_request_id  text,
  outreach_thread_id text,
  message_version    text,
  meta               jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS prospects_status_idx ON prospects (playbook, status);

-- Outreach templates must be approved by a founder before agents may send them.
CREATE TABLE IF NOT EXISTS templates (
  id           text PRIMARY KEY,
  playbook     text NOT NULL,
  version      text NOT NULL,
  subject      text NOT NULL,
  body         text NOT NULL,                 -- may contain {{placeholders}}
  status       text NOT NULL DEFAULT 'draft', -- draft | approved | retired
  approved_by  text,
  approved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (playbook, version)
);

CREATE TABLE IF NOT EXISTS messages (
  id                    text PRIMARY KEY,
  direction             text NOT NULL,       -- outbound | inbound
  inbox                 text NOT NULL,       -- hello | data | outreach
  request_id            text,
  prospect_id           text,
  order_id              text,
  counterpart_email     text NOT NULL,
  subject               text,
  body_text             text,
  template_id           text,
  agentmail_message_id  text,
  thread_id             text,
  status                text NOT NULL DEFAULT 'sent', -- draft | blocked | sent | received | bounced
  blocked_reason        text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (thread_id);
CREATE INDEX IF NOT EXISTS messages_inbox_idx  ON messages (inbox, direction, created_at DESC);

-- Opt-outs, bounces and complaints. Checked before every outbound send.
CREATE TABLE IF NOT EXISTS suppression (
  email       text PRIMARY KEY,
  reason      text NOT NULL,                  -- opt_out | bounce | complaint | manual
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Coordinator: playbook effort allocation over time
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS playbook_allocations (
  id          bigserial PRIMARY KEY,
  playbook    text NOT NULL,
  weight      numeric(5,4) NOT NULL,          -- share of outreach effort, 0..1
  reason      text NOT NULL,
  metrics     jsonb NOT NULL DEFAULT '{}',    -- reply rate, cost per report, value at time of decision
  decided_by  text NOT NULL DEFAULT 'coordinator',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Monitoring subscriptions (re-check a site on a schedule)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS monitors (
  id                    text PRIMARY KEY,
  request_id            text NOT NULL,
  lat                   double precision NOT NULL,
  lon                   double precision NOT NULL,
  aoi                   jsonb,
  recipe                text NOT NULL,       -- analysis recipe to re-run
  metric                text NOT NULL,
  threshold             double precision,
  cadence               text NOT NULL,       -- cron expression
  last_checked_at       timestamptz,
  last_value            double precision,
  last_scene_date       date,
  status                text NOT NULL DEFAULT 'active', -- active | paused | cancelled
  naive_deployment_id   text,
  created_at            timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Money: spend (cost) and revenue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS spend (
  id           bigserial PRIMARY KEY,
  service      text NOT NULL,                 -- naive | monid | neon | data
  agent        text,
  session_id   text,
  request_id   text,
  component    text,                          -- model | computer | tools | data | ...
  amount_usd   numeric(12,6) NOT NULL,
  is_estimate  boolean NOT NULL DEFAULT false,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  meta         jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS spend_request_idx ON spend (request_id);
CREATE INDEX IF NOT EXISTS spend_time_idx    ON spend (recorded_at);

CREATE TABLE IF NOT EXISTS revenue (
  id           bigserial PRIMARY KEY,
  request_id   text,
  quote_id     text,
  amount_usd   numeric(12,2) NOT NULL,
  kind         text NOT NULL,                 -- paid | committed | stated_willingness
  note         text,
  recorded_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Intervention log: every human action, with time and reason. Judges score this.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS interventions (
  id          bigserial PRIMARY KEY,
  actor       text NOT NULL,                  -- founder name
  action      text NOT NULL,                  -- approve_order | approve_template | edit_report | manual_reply | fix | ...
  reason      text NOT NULL,
  request_id  text,
  ref_id      text,                           -- order/template/report id acted on
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Public API keys + fixed-window rate limiting (no extra services)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS api_keys (
  id               text PRIMARY KEY,
  key_hash         text NOT NULL UNIQUE,      -- sha256 of the key; raw key shown once
  owner            text NOT NULL,
  rate_per_hour    integer NOT NULL DEFAULT 30,
  revoked          boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        text NOT NULL,                -- e.g. key:<id> or ip:<addr>
  window_start  timestamptz NOT NULL,
  count         integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- Market researcher output: what today's alternatives cost, with citations.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS market_prices (
  id            text PRIMARY KEY,
  playbook      text NOT NULL,
  alternative   text NOT NULL,                -- e.g. "drone roof inspection", "EUDR compliance audit"
  price_low     numeric(12,2),
  price_high    numeric(12,2),
  unit          text NOT NULL,                -- per site | per report | per km2 | per month
  turnaround    text,
  source_title  text NOT NULL,
  source_url    text NOT NULL,
  retrieved_at  date NOT NULL,
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Bookkeeping for the migration runner.
CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);
