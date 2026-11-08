/** OWNER: outbound builder. Catalog group "signals" (Sourcing agent): poll feeds, list, triage. */
import { z } from "zod";
import { Playbook, SignalFeed } from "../../domain";
import { guarded } from "../../outbound/errors";
import { listSignals, pollSignals, updateSignals } from "../../outbound/signals";
import type { ToolRegistrar } from "../types";

const OutboundPlaybook = Playbook.exclude(["inbound"]);

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "poll_signals",
    {
      playbook: OutboundPlaybook,
      since_hours: z.number().positive().max(24 * 30).optional().describe("only events newer than this; default: each feed's own window"),
      limit_per_feed: z.number().int().min(1).max(200).optional().describe("default 50"),
      allow_paid: z
        .boolean()
        .optional()
        .describe("include paid feeds (mining news via Monid, about $0.01 per poll, inside the Monid per-call and per-day caps); default true, false = free feeds only"),
    },
    (a, ctx) =>
      pollSignals({ playbook: a.playbook, sinceHours: a.since_hours, limitPerFeed: a.limit_per_feed, allowPaid: a.allow_paid, actor: ctx.agent }),
  );

  r.tool(
    "list_signals",
    {
      playbook: Playbook.optional(),
      status: z.enum(["new", "matched", "ignored"]).optional(),
      feed: SignalFeed.optional(),
      since_hours: z.number().positive().optional(),
      limit: z.number().int().min(1).max(100).optional().describe("default 30"),
      include_raw: z.boolean().optional().describe("include the feed's raw record (truncated) for matching"),
    },
    async (a) => ({
      signals: await listSignals({ playbook: a.playbook, status: a.status, feed: a.feed, sinceHours: a.since_hours, limit: a.limit, includeRaw: a.include_raw }),
    }),
  );

  r.tool(
    "update_signal",
    {
      signal_ids: z.array(z.string()).min(1).max(100).describe("one or more signal ids with the same verdict"),
      status: z.enum(["matched", "ignored"]),
      reason: z.string().min(3).max(1000).describe("why: who is affected, or why nobody we can help is"),
    },
    (a, ctx) => updateSignals({ ids: a.signal_ids, status: a.status, reason: a.reason, actor: ctx.agent }),
  );
}
