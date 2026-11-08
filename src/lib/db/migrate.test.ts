import { describe, expect, it, vi } from "vitest";
import { createDb } from "./client";
import { migrate, splitSql } from "./migrate";

describe("splitSql", () => {
  it("splits on top-level semicolons, ignores comments and quoted semicolons", () => {
    const parts = splitSql(`-- header\nCREATE TABLE a (x text DEFAULT 'a;b'); -- trailing\nCREATE INDEX i ON a (x);\n`);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain("'a;b'");
  });
});

describe("migrate", () => {
  it("applies the schema on PGlite and is idempotent", async () => {
    const db = await createDb({ memory: true });
    const first = await migrate(db);
    expect(first).toContain("001_init.sql");
    expect(await migrate(db)).toEqual([]);

    const tables = await db.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1",
    );
    const names = tables.map((t) => t.table_name);
    for (const t of ["requests", "events", "decisions", "quotes", "orders", "reports", "earth_index", "providers",
      "signals", "prospects", "templates", "messages", "suppression", "playbook_allocations", "monitors", "spend",
      "revenue", "interventions", "api_keys", "rate_limits", "market_prices", "schema_migrations"]) {
      expect(names).toContain(t);
    }

    await db.query(
      "INSERT INTO requests (id, source, question, h3_cells, meta) VALUES ($1, $2, $3, $4, $5)",
      ["req_test", "portal", "Did it flood?", ["872830828ffffff"], JSON.stringify({ a: 1 })],
    );
    const [row] = await db.query<{ status: string; h3_cells: string[]; meta: { a: number } }>(
      "SELECT status, h3_cells, meta FROM requests WHERE id = $1", ["req_test"],
    );
    expect(row.status).toBe("received");
    expect(row.h3_cells).toEqual(["872830828ffffff"]);
    expect(row.meta.a).toBe(1);
    await db.close();
  });
});

describe("PGlite data dirs", () => {
  it("shares one instance per data dir, so pages and routes in next dev see the same data", async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(tmpdir(), "tg-pglite-"));
    vi.stubEnv("TERRAGENT_DB", ""); // vitest forces memory mode, which ignores data dirs; this test needs a real dir
    const a = await createDb({ dataDir: dir });
    const b = await createDb({ dataDir: dir });
    await a.query("CREATE TABLE t (x int)");
    await a.query("INSERT INTO t VALUES (42)");
    expect(await b.query<{ x: number }>("SELECT x FROM t")).toEqual([{ x: 42 }]);
    await a.close();
    vi.unstubAllEnvs();
  });
});
