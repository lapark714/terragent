/** Small query helpers shared by the pipeline services. */
import { getDb, type Row } from "../db/client";

export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  return db.query<T>(text, params);
}

export async function queryOne<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  return (await query<T>(text, params))[0] ?? null;
}

/** Postgres numeric comes back as a string; normalise to number (null stays null). */
export function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export const json = (v: unknown) => JSON.stringify(v);

export const round2 = (n: number) => Math.round(n * 100) / 100;

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
