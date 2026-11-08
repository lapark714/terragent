/**
 * Database access. One tiny interface, two backends:
 *   - Neon (serverless HTTP driver) when DATABASE_URL is set — production / Vercel.
 *   - PGlite (embedded Postgres in WASM) otherwise — local dev and tests, no Docker.
 *
 * Always use parameterized queries: db.query("... where id = $1", [id]).
 * PGlite note: only one process can open a given data dir at a time
 * (stop `next dev` before running a script against the same .pglite dir, or use TERRAGENT_DB=memory).
 */
import type { PGlite } from "@electric-sql/pglite";

export type Row = Record<string, unknown>;

export interface Db {
  readonly kind: "neon" | "pglite";
  query<T = Row>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

let cached: Promise<Db> | null = null;

/** Shared singleton. Tests should call createDb({ memory: true }) instead. */
export function getDb(): Promise<Db> {
  if (!cached) cached = createDb();
  return cached;
}

/** Test hook: replace the singleton (e.g. with an in-memory PGlite). */
export function setDb(db: Db | null) {
  cached = db ? Promise.resolve(db) : null;
}

export async function createDb(opts: { url?: string; memory?: boolean; dataDir?: string } = {}): Promise<Db> {
  // TERRAGENT_DB wins over DATABASE_URL, so tests, dry runs and local UI work can never touch production Neon:
  //   memory → in-memory PGlite (tests);  local → persistent demo PGlite in .pglite-demo/ (npm run dev:local).
  const mode = process.env.TERRAGENT_DB;
  const memory = opts.memory || mode === "memory";
  if (mode === "local" && !opts.url && !memory) return createPgliteDb(opts.dataDir ?? process.env.PGLITE_DATA_DIR ?? ".pglite-demo");
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url && !memory) return createNeonDb(url);
  return createPgliteDb(memory ? undefined : (opts.dataDir ?? ".pglite"));
}

async function createNeonDb(url: string): Promise<Db> {
  const { neon } = await import("@neondatabase/serverless");
  const sql = neon(url);
  return {
    kind: "neon",
    async query<T = Row>(text: string, params: unknown[] = []) {
      return (await sql.query(text, params)) as T[];
    },
    async close() {},
  };
}

async function createPgliteDb(dataDir?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg: PGlite = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  return {
    kind: "pglite",
    async query<T = Row>(text: string, params: unknown[] = []) {
      const res = await pg.query<T>(text, params);
      return res.rows;
    },
    async close() {
      await pg.close();
    },
  };
}
