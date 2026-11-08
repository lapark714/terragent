/** How often a request's status page asks for news. Pure, so it is tested on its own (poll.test.ts). */
import type { RequestProgress } from "@/lib/dashboard/public";

/**
 * The server caches each request's progress for 8 s, so polling faster buys nothing. Once nothing has happened
 * for a while (waiting on the customer or a founder) the page slows down, and a finished request only checks now
 * and then (Neon $250 rule, NOTES H4c). `now` is null until the client clock starts.
 */
export function pollIntervalMs(p: Pick<RequestProgress, "terminal" | "updatedAt" | "events">, now: number | null): number {
  if (p.terminal) return 120_000;
  const last = Math.max(Date.parse(p.updatedAt) || 0, ...p.events.map((e) => Date.parse(e.at) || 0));
  const quiet = now === null || !last ? 0 : now - last;
  if (quiet > 30 * 60_000) return 60_000;
  if (quiet > 5 * 60_000) return 20_000;
  return 8_000;
}
