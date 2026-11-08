-- Naïve module: board card generations.
-- Naïve starts a board card at most 3 times, then parks it blocked, and re-assigning does not reset
-- that (verified live, docs/platform/naive-live.md §7). A background request needs ~6 wakes, so
-- upsertCard continues it on a fresh card keyed "<key>#<generation>" and records the generation here.
CREATE TABLE IF NOT EXISTS naive_card_generations (
  key         text PRIMARY KEY,                -- the caller's card key, e.g. req:req_…
  generation  integer NOT NULL DEFAULT 0,      -- 0 = the card keyed by `key` itself
  updated_at  timestamptz NOT NULL DEFAULT now()
);
