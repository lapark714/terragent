/** Small helpers shared by the outbound services. */
import type { Playbook } from "../domain";
import { DEFAULT_ALLOCATION } from "../config";

export type OutboundPlaybook = Exclude<Playbook, "inbound">;
export const OUTBOUND_PLAYBOOKS = Object.keys(DEFAULT_ALLOCATION) as OutboundPlaybook[];

/** Postgres numeric / bigint come back as strings from Neon; normalise. */
export const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
export const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

export function startOfUtcDay(d = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function hoursAgo(hours: number, now = new Date()): Date {
  return new Date(now.getTime() - hours * 3_600_000);
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** Ratio rounded to 3 decimals; null when the denominator is 0. */
export function ratio(a: number, b: number): number | null {
  return b > 0 ? Math.round((a / b) * 1000) / 1000 : null;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
