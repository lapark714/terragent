/** Display formatting shared by the site and mission control. Pure functions: safe on server and client. */
import type { AgentName, DecisionKind, RequestStatus } from "@/lib/domain";

export function usd(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  const digits = Math.abs(n) < 100 && n % 1 !== 0 ? 2 : 0;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const count = (n: number) => n.toLocaleString("en-US");

/** "1 verified report", "3 verified reports" */
export const plural = (n: number, word: string) => `${count(n)} ${word}${n === 1 ? "" : "s"}`;

/** Compact elapsed time: 12s, 4m, 3h, 2d. */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** Stable across server and client (always UTC). */
export function clockUtc(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

export function dateUtc(iso: string | null): string {
  if (!iso) return "date unknown";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function duration(seconds: number | null): string {
  if (seconds === null) return "–";
  if (seconds < 90) return `${Math.round(seconds)} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

export const STATUS_LABEL: Record<RequestStatus, string> = {
  received: "Received",
  screening: "Screening",
  clarifying: "Asked the customer",
  planning: "Planning",
  acquiring: "Choosing data",
  pricing: "Pricing",
  quoted: "Quote sent",
  awaiting_approval: "Waiting on a founder",
  fetching: "Fetching data",
  analyzing: "Analyzing",
  verifying: "Verifying",
  revising: "Revising",
  delivering: "Delivering",
  delivered: "Delivered",
  refused: "Refused",
  failed: "Failed",
  cancelled: "Cancelled",
};

const AGENT_LABEL: Record<AgentName, string> = {
  coordinator: "Coordinator",
  "comms-customer": "Customer comms",
  "comms-suppliers": "Supplier comms",
  "comms-outreach": "Outreach",
  planner: "Planner",
  acquisition: "Acquisition",
  pricing: "Pricing",
  interpreter: "Interpreter",
  analytics: "Analytics",
  verifier: "Verifier",
  sourcing: "Sourcing",
  "market-researcher": "Market research",
};

/** "planner" → "Planner"; "human:Laurence" → "Laurence"; unknown actors pass through. */
export function actorLabel(actor: string | null): string {
  if (!actor) return "Unassigned";
  if (actor.startsWith("human:")) return actor.slice(6);
  if (actor === "system") return "System";
  return AGENT_LABEL[actor as AgentName] ?? actor;
}

export const isHuman = (actor: string) => actor.startsWith("human:");

export const DECISION_LABEL: Record<DecisionKind, string> = {
  screening: "Screening",
  source_selection: "Source chosen",
  free_vs_paid: "Free vs paid",
  pricing: "Pricing",
  verification: "Verification",
  outreach: "Outreach",
  playbook_allocation: "Effort shift",
  monitoring: "Monitoring",
};

const EVENT_LABEL: Record<string, string> = {
  "request.created": "Request received",
  "status.changed": "Moved to the next step",
  handoff: "Handed off",
  "decision.logged": "Logged a decision",
  "human.intervention": "A founder stepped in",
  "human.intervention_undone": "A founder's action was rolled back",
  "email.sent": "Sent an email",
  "email.received": "Received an email",
  "email.blocked": "Held an email at our gate",
  "email.blocked_by_provider": "Email refused by the provider",
  "data_spec.saved": "Wrote the data spec",
  "acquisition_plan.saved": "Chose the data",
  "report.saved": "Wrote the report",
  "report.drafted": "Drafted the report",
  "report.verified": "Report verified",
  "analysis.saved": "Finished the analysis",
  "quote.created": "Priced a quote",
  "quote.sent": "Sent a quote",
  "quote.accepted": "Quote accepted",
  "order.prepared": "Held a paid order for a founder",
  "order.approved": "Paid order approved",
  "order.rejected": "Paid order rejected",
  "payment.recorded": "A payment was recorded",
  "supplier_quote.requested": "Asked a supplier for a price",
  "customer_message.sent": "Wrote to the customer",
  "signals.polled": "Polled the signal feeds",
  "prospect.created": "Matched a business",
  "prospect.sample_requested": "Started a free sample",
  "prospect.replied": "A business replied",
  "monitor.followup": "Followed up with new imagery",
  "offline.skipped": "Skipped a call (local mode)",
};

/** Services named in events (offline.skipped, spend). */
export const SERVICE_LABEL: Record<string, string> = { naive: "Naïve", agentmail: "AgentMail", monid: "Monid", neon: "Neon" };

/** "data_spec.saved" → "Data spec saved" when no friendlier label exists. */
export function eventLabel(type: string): string {
  if (EVENT_LABEL[type]) return EVENT_LABEL[type];
  const words = type.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "approve_order" → "Approve order" */
export function actionLabel(action: string): string {
  const words = action.replace(/[._]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
