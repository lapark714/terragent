/**
 * Client-side shape of GET /api/dashboard/prospects (src/lib/dashboard/prospects.ts on the backend branch), and the
 * outreach vocabulary the Signal Engine shows. Kept here so the UI builds on its own while that endpoint is reviewed.
 */
import type { Layer, Playbook } from "@/lib/domain";
import type { Panel } from "@/lib/dashboard/types";

export interface SignalProspect {
  id: string;
  company: string;
  domain: string | null;
  role: string | null;
  asset: string | null;
  score: number | null;
  status: string;
  channel: string | null;
  updatedAt: string;
}
export interface SignalWithProspects {
  id: string;
  playbook: Playbook;
  layer: Layer;
  feed: string;
  title: string;
  severity: string | null;
  at: string;
  prospects: SignalProspect[];
}
export interface FeedConversion {
  feed: string;
  playbook: Playbook;
  signals: number;
  matched: number;
  reached: number;
  replied: number;
  quoted: number;
  paid: number;
  optedOut: number;
}
export interface SignalProspects { signals: SignalWithProspects[]; byFeed: FeedConversion[] }
export type SignalProspectsResponse = Panel<SignalProspects> & { dbSuspended: boolean };

/** Where outreach to a business stands, from the founder's side. Order = how a signal's businesses are listed. */
export const OUTREACH_GROUPS = ["responded", "reached", "pending", "closed"] as const;
export type OutreachGroup = (typeof OUTREACH_GROUPS)[number];

export const OUTREACH_GROUP_LABEL: Record<OutreachGroup, string> = {
  responded: "Responded",
  reached: "Reached, waiting",
  pending: "Not reached yet",
  closed: "Closed",
};

const STATUS: Record<string, { label: string; group: OutreachGroup }> = {
  matched: { label: "Matched, not contacted", group: "pending" },
  sample_requested: { label: "Making a free sample", group: "pending" },
  sample_ready: { label: "Sample ready, not sent", group: "pending" },
  emailed: { label: "Reached, no reply yet", group: "reached" },
  replied: { label: "Replied", group: "responded" },
  quoted: { label: "Replied, quoted", group: "responded" },
  paid: { label: "Paid", group: "responded" },
  opted_out: { label: "Opted out", group: "closed" },
  disqualified: { label: "Ruled out", group: "closed" },
};

export function outreachStatus(status: string): { label: string; group: OutreachGroup } {
  return STATUS[status] ?? { label: status.replace(/_/g, " "), group: "pending" };
}

/** Status pill colours: payment and replies green, a sent touch indigo, not yet reached grey, opt-outs in the alert colour. */
export function statusTone(status: string): string {
  if (status === "paid") return "border-forest bg-forest/15 text-forest";
  if (status === "opted_out") return "border-alert/70 text-alert";
  const g = outreachStatus(status).group;
  return g === "responded" ? "border-forest/70 text-forest" : g === "reached" ? "border-inbound/70 text-inbound-hi" : "border-line-strong text-fg-3";
}

export const CHANNEL_LABEL: Record<string, string> = { contact_form: "Contact form", email_warm: "Warm email", email_direct: "Cold email" };

export function countGroups(prospects: SignalProspect[]): Record<OutreachGroup, number> {
  const c = { responded: 0, reached: 0, pending: 0, closed: 0 };
  for (const p of prospects) c[outreachStatus(p.status).group] += 1;
  return c;
}

/** Businesses for one signal: responded first, then reached, not reached, closed; best score first within a group. */
export function sortProspects(prospects: SignalProspect[]): SignalProspect[] {
  const rank = (p: SignalProspect) => OUTREACH_GROUPS.indexOf(outreachStatus(p.status).group);
  return [...prospects].sort((a, b) => rank(a) - rank(b) || (b.score ?? 0) - (a.score ?? 0));
}

export const rate = (n: number, of: number): string => (of > 0 ? `${Math.round((n / of) * 100)}%` : "–");
