# Platform reference: Neon Postgres, local test DB (PGlite), H3 Earth index

Status: COMPLETE (research pass 2026-11-07). Verified 2026-11-07 on macOS, Node v24.21.0, Python 3.13.
Evidence scripts (scratch, not in repo): `/private/tmp/claude-504/-Users-laurence-terragent/22c3e839-95bd-4a29-a8d4-0ec9c4c36ffd/scratchpad/research/database/` - `lib/db.ts`, `scripts/test_db.ts`, `scripts/test_db_pool.ts`, `scripts/migrate.ts`, `scripts/param_test.mjs`, `pglite_test.mjs`, `pglite_postgis_test.mjs`, `neon_parse_offline.mjs`, `neon_types_offline.mjs`, `h3_test.mjs`, `pyscripts/h3_test.py`, `migrations/*.sql`; fetched docs in `docs2/`.
Evidence legend: **[RUN]** = executed on this machine, output pasted/trimmed; **[TYPES]** = read from the published package's `.d.ts`/source; **[DOCS]** = fetched official doc page (raw `.md`); **[UNVERIFIED]** = see section 8.

## 1. TL;DR for builders
- Import: `import { neon, Pool } from '@neondatabase/serverless'` (1.2.0) in prod; `import { PGlite } from '@electric-sql/pglite'` (0.5.15, devDependency, dynamic import) locally; `import { latLngToCell, polygonToCells, cellToBoundary, gridDisk, isValidCell } from 'h3-js'` (4.5.0 - NOT the npm package `h3`). Python: `pip install h3` (4.5.0).
- Use `lib/db.ts` (section 3.7): `getDb()` -> Neon if `DATABASE_URL` is set, PGlite (in-memory, or `PGLITE_DATA_DIR`) if not; same JS types from both. Verified on PGlite and on both Neon driver paths via offline shims.
- The 5 calls: `` sql`SELECT ... ${v}` `` / `sql.query(text, params, { types })` (HTTP, one query); `new Pool({ connectionString, types })` + `client.query('BEGIN')...` (interactive tx, create+close per request on Vercel); `PGlite.create({ dataDir, parsers })` + `pg.query/exec/transaction`; `polygonToCells(geojson.coordinates, 8, true)`; `cellToBoundary(cell, true)` for GeoJSON.
- Store H3 ids as lowercase `text` / `text[]` computed in app code (res 8 default, ~531 m edge). Neon has postgis/h3/h3_postgis on Free, but PGlite has no h3, so don't depend on the extension.
- `DATABASE_URL` = pooled (`-pooler` host) for the app; `DATABASE_URL_UNPOOLED` = direct for migrations. Create the Neon project on **Postgres 18** (PGlite is 18.6).
- Traps: `sql('...')` throws (tagged template only); `neon(url, {types})` ignores `types` (pass per query); int8/count come back as **strings** from Neon but numbers/bigint from PGlite; dates differ (Neon local midnight vs PGlite UTC midnight); **JSON.stringify every jsonb param** (arrays break on Neon but pass on PGlite); `polygonToCells` wants `[lat,lng]` unless `isGeoJson=true` (silent 0 cells otherwise); h3-js `cellToLatLng` does not throw on garbage (call `isValidCell`); Free plan suspends compute when 100 CU-h/month is used up and scales to zero after 5 min.

## 2. Install & setup

| Package | Verified version | Published | Evidence |
|---|---|---|---|
| `@neondatabase/serverless` | **1.2.0** (latest dist-tag) | 2026-10-01 | `npm view` [RUN]; `engines.node >=19.0.0`; unpacked 452 KB |
| `@electric-sql/pglite` | **0.5.15** (latest) | 2026-11-03 | `npm view` + installed and run [RUN]; embeds **PostgreSQL 18.6**; unpacked 26 MB |
| `@electric-sql/pglite-postgis` | **0.2.15** (latest) | 2026-11-03 | installed and run [RUN]; `peerDependencies: {"@electric-sql/pglite": "0.5.15"}` (exact pin); 19 MB (postgis.tar.gz 20 MB) |
| `h3-js` | **4.5.0** (latest) | 2026-07-01 | installed and run [RUN]; types at `dist/types.d.ts`; Apache-2.0; 7.4 MB unpacked |
| Python `h3` (PyPI) | **4.5.0** (latest) | - | `pip install h3` in venv, run [RUN]; versions 4.1.0..4.5.0 are the v4 API |

```bash
# app (Next.js on Vercel + Node scripts)
npm install @neondatabase/serverless@1.2.0 h3-js@4.5.0
# local/test DB only (no Docker, no Neon account needed)
npm install -D @electric-sql/pglite@0.5.15
# optional, only if you really want PostGIS locally (20 MB wasm bundle; must match pglite version exactly)
npm install -D @electric-sql/pglite-postgis@0.2.15
# Python (Naive sandbox / Analytics agent)
pip install "h3>=4.1,<5"
```
- Node 24 (this machine, v24.21.0) has a global `WebSocket`, so Neon `Pool`/`Client` need no `ws` package. PGlite needs no native build; `npm install --ignore-scripts` worked for all four packages.
- Next.js note [UNVERIFIED]: keep PGlite out of the Vercel bundle by importing it dynamically only when `DATABASE_URL` is unset (see 3.7) and listing it in `serverExternalPackages` in `next.config` if the bundler complains.

## 3. API reference

### 3.1 Neon: connection strings (pooled vs direct)

```text
direct : postgresql://user:pw@ep-cool-darkness-123456.us-east-2.aws.neon.tech/dbname?sslmode=require
pooled : postgresql://user:pw@ep-cool-darkness-123456-pooler.us-east-2.aws.neon.tech/dbname?sslmode=require
```
- Pooled = same endpoint id with `-pooler` suffix; PgBouncer in **transaction mode** (`pool_mode=transaction`), `max_client_conn=10000`, `default_pool_size = 0.9 x max_connections`, `max_prepared_statements=1000`; queue wait 2 min before error.
- Use **pooled** for serverless functions / web apps; use **direct** for schema migrations, `pg_dump`/`pg_restore`, logical replication, admin tasks, long analytics queries.
- Transaction mode breaks session features: `SET`/`RESET` (incl. `SET search_path`), `LISTEN`/`NOTIFY`, SQL-level `PREPARE`/`DEALLOCATE`, session advisory locks. Workaround for search_path: `ALTER ROLE user1 SET search_path TO ...`.
- The pooled endpoint is always available; the Console "Connection pooling" toggle only changes which string it displays (on by default).
- Vercel-managed (Marketplace) integration injects: `DATABASE_URL` (pooled), `DATABASE_URL_UNPOOLED` (direct), `PGHOST`, `PGHOST_UNPOOLED`, `PGUSER`, `PGDATABASE`, `PGPASSWORD`, legacy `POSTGRES_*`.

Source: https://neon.com/docs/connect/connection-pooling.md (Last updated 2026-10-19) lines 197-299 [DOCS]; https://neon.com/docs/guides/vercel-managed-integration.md "Environment variables set by the integration" [DOCS]

### 3.2 Neon serverless driver: `neon()` over HTTP (one query per HTTP POST, no session)

Signatures (from `node_modules/@neondatabase/serverless/index.d.ts` v1.2.0) [TYPES]:
```ts
export declare function neon<ArrayMode extends boolean = false, FullResults extends boolean = false>(
  connectionString: string, neonOpts?: HTTPTransactionOptions<ArrayMode, FullResults>): NeonQueryFunction<ArrayMode, FullResults>;   // d.ts:595
export declare function neon(neonOpts: HTTPTransactionOptions<...>): NeonQueryFunction<...>;                                      // d.ts:614

interface NeonQueryFunction<A, F> {                                                                                                // d.ts:856
  (strings: TemplateStringsArray, ...params: any[]): NeonQueryPromise<...>;          // tagged template ONLY
  query(queryWithPlaceholders: string, params?: any[], queryOpts?: HTTPQueryOptions<A, F>): NeonQueryPromise<...>;
  unsafe(rawSQL: string): UnsafeRawSql;                                               // raw SQL fragment (trusted strings only)
  transaction(queriesOrFn: NeonQueryPromise[] | ((sql: NeonQueryFunctionInTransaction) => NeonQueryInTransaction[]),
              opts?: HTTPTransactionOptions<A, F>): Promise<rows[][]>;                // NON-interactive batch
}
interface HTTPQueryOptions<A, F> extends ConnectionParams {                                                                        // d.ts:438
  arrayMode?: A; fullResults?: F; fetchOptions?: Record<string, any>;
  authToken?: string | (() => Promise<string> | string); types?: CustomTypesConfig; disableWarningInBrowsers?: boolean;
}
interface HTTPTransactionOptions<A, F> extends HTTPQueryOptions<A, F> {                                                            // d.ts:484
  isolationLevel?: 'ReadUncommitted' | 'ReadCommitted' | 'RepeatableRead' | 'Serializable';
  readOnly?: boolean; deferrable?: boolean;
}
export declare class NeonDbError extends Error { name: 'NeonDbError'; code; severity; detail; hint; position; constraint; table; column; schema; ...; sourceError } // d.ts:834
```
Usage:
```ts
import { neon } from '@neondatabase/serverless';
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT * FROM earth_index WHERE h3_cell = ${cell}`;          // params are bound, not interpolated
const rows2 = await sql.query('SELECT * FROM earth_index WHERE h3_cell = $1', [cell]); // conventional form
const where = sql`WHERE layer = ${'forest'}`;                                       // composable fragments
const rows3 = await sql`SELECT * FROM earth_index ${where} LIMIT ${10}`;
const [a, b] = await sql.transaction([sql`UPDATE ...`, sql`SELECT ...`], { isolationLevel: 'Serializable' });
```
Wire format, observed with the real driver code against a mock `neonConfig.fetchFunction` [RUN, offline - not a live Neon]:
```text
POST https://api.us-east-2.aws.neon.tech/sql          (host = connection-string host with first label replaced by "api")
headers: Neon-Connection-String: postgresql://...&application_name=pkg%3Anpm%2F%2540neondatabase%2Fserverless%401.2.0
         Neon-Raw-Text-Output: true   Neon-Array-Mode: true
         (transaction adds) Neon-Batch-Isolation-Level: Serializable   Neon-Batch-Read-Only: true
body   : {"query":"SELECT $1::text AS p, $2 AS arr, $3 AS j","params":["x","{\"1\",\"2\"}","{\"a\":1}"]}
         transaction: {"queries":[{"query":"SELECT 1","params":[]},{"query":"SELECT $1","params":["2"]}]}
```
- Calling `sql('SELECT 1')` throws: "This function can now be called only as a tagged-template function ... use sql.query(...)" [RUN]. (Breaking change since 1.0.0 per docs Troubleshooting.)
- Errors: `NeonDbError` with Postgres `code` e.g. `42P01` [RUN].
- Max request and response size over HTTP: **64 MB**.

Source: index.d.ts lines cited above [TYPES]; https://neon.com/docs/serverless/serverless-driver.md (Last updated 2026-10-05) [DOCS]; scratch script `neon_parse_offline.mjs` [RUN]

### 3.3 Neon serverless driver: `Pool` / `Client` over WebSockets (sessions, interactive transactions, node-postgres API)

```ts
import { Pool } from '@neondatabase/serverless';
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
try { await client.query('BEGIN'); await client.query('UPDATE ...', [x]); await client.query('COMMIT'); }
catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
await pool.end();
```
- Node.js 22+ has a global `WebSocket`; Node <=21 needs `import ws from 'ws'; neonConfig.webSocketConstructor = ws;`. Our Node 24 needs nothing.
- **Vercel functions / Next.js route handlers: create, use and close the Pool inside the handler** (`after(() => pool.end())` from `next/server`, or `waitUntil(pool.end())` from `@vercel/functions`). In edge runtimes a WebSocket cannot outlive a request.
- `Pool`/`Client` are the node-postgres classes re-exported (`export declare class Pool extends Pool_2`, d.ts:1000; `Client` d.ts:195). Kysely / Drizzle (`drizzle-orm/neon-serverless`) / Prisma (`@prisma/adapter-neon`) work on top.

Source: https://neon.com/docs/serverless/serverless-driver.md sections "Use the driver over WebSockets", "Pool and Client usage notes" [DOCS]; index.d.ts:195,1000 [TYPES]

### 3.4 Neon: extensions (PostGIS, h3, h3_postgis)

Quoted from https://neon.com/docs/extensions/pg-extensions.md (Last updated 2026-11-04) [DOCS]:
```text
| Extension   | PG14   | PG15   | PG16   | PG17  | PG18  | Notes
| h3          | 4.1.3  | 4.1.3  | 4.1.3  | 4.1.3 | 4.2.3 | Some components have been split out into the `h3_postgis` extension. Install both the `h3` and `h3_postgis` extensions.
| h3_postgis  | 4.1.3  | 4.1.3  | 4.1.3  | 4.1.3 | 4.2.3 | Install with `CREATE EXTENSION h3_postgis CASCADE;` (requires `postgis` and `postgis_raster`)
| postgis     | 3.3.10 | 3.3.10 | 3.3.10 | 3.5.7 | 3.6.4 |
| postgis_raster | 3.3.10 | 3.3.10 | 3.3.10 | 3.5.7 | 3.6.4 |
```
- The only plan restriction on that page is on `pg_repack` ("Available only on paid Neon plans"); postgis/h3/h3_postgis carry no plan note, so (inference from the absence of a note) they are available on Free. Confirm with the query in section 5.
- Enable (from https://neon.com/docs/extensions/postgis-related-extensions.md "H3 and H3 PostGIS"):
```sql
CREATE EXTENSION IF NOT EXISTS h3 CASCADE;
CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;   -- pulls in postgis + postgis_raster
SELECT h3_lat_lng_to_cell(pickup_location, 9) FROM ride_pickups;  -- Neon's example; on PG18 (h3 4.2.3) the name is h3_latlng_to_cell, see next bullet
```
- New extension versions need a compute restart to become installable (happens on scale-to-zero anyway).
- Neon runs Postgres 14-18; latest minors as of Aug 2026: 18.6, 17.11, 16.15, 15.19, 14.24 (https://neon.com/docs/postgresql/postgres-version-policy.md) [DOCS].

- **h3-pg function names changed in 4.2.3** (the version Neon ships for PG18): "Alter function names containing `lat_lng` to `latlng`" (h3-pg CHANGELOG 4.2.3, 2025-06-24). So on Neon PG18 use `h3_latlng_to_cell(...)`, `h3_cell_to_latlng(...)`; Neon's own example (`h3_lat_lng_to_cell`) matches the PG14-17 build (4.1.3). Upstream API doc: `h3_latlng_to_cell(latlng point, resolution integer) => h3index`, `h3_grid_disk(origin h3index, [k integer = 1]) => SETOF h3index`, `h3_cell_to_boundary(cell h3index) => polygon`, `h3_get_resolution(h3index) => integer`. Column type is `h3index` (not text). Whether 4.2.3 kept the old `lat_lng` names as aliases is not stated in the changelog [UNVERIFIED].

Source: https://raw.githubusercontent.com/zachasme/h3-pg/main/CHANGELOG.md, https://raw.githubusercontent.com/zachasme/h3-pg/main/docs/api.md [DOCS]

### 3.5 PGlite (local test DB, in-process WASM Postgres, no Docker, no account)

Signatures (`node_modules/@electric-sql/pglite/dist/interface-DuFeKlK4.d.ts`, v0.5.15) [TYPES]:
```ts
class PGlite {                                                         // d.ts:705
  constructor(dataDir?: string, options?: PGliteOptions); constructor(options?: PGliteOptions);
  static create<O extends PGliteOptions>(options?: O): Promise<PGlite & ...>;                 // d.ts:746 (preferred: awaits ready)
  static create<O extends PGliteOptions>(dataDir?: string, options?: O): Promise<PGlite & ...>;
}
interface PGliteOptions { dataDir?: string; extensions?: Extensions; parsers?: ParserOptions; serializers?: SerializerOptions;
  debug?: 0|1|2|3|4|5; relaxedDurability?: boolean; username?: string; database?: string; loadDataDir?: Blob|File; ... } // d.ts:1072
interface ParserOptions { [pgType: number]: (value: string) => any }                          // d.ts:1020  keyed by type OID
interface QueryOptions { rowMode?: 'array'|'object'; parsers?; serializers?; blob?; onNotice?; paramTypes?: number[] } // d.ts:1026
// PGliteInterface (d.ts:1096):
query<T>(query: string, params?: any[], options?: QueryOptions): Promise<Results<T>>;   // ONE statement, $1..$n
sql<T>(sqlStrings: TemplateStringsArray, ...params: any[]): Promise<Results<T>>;        // tagged template
exec(query: string, options?: QueryOptions): Promise<Array<Results>>;                  // MANY statements, no params
transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T>;                 // interactive; throw => ROLLBACK
close(): Promise<void>; listen(channel, cb); dumpDataDir(...)
type Results<T> = { rows: T[]; affectedRows?: number; command?: string; rowCount?: number; fields: {name: string; dataTypeID: number}[]; blob?: Blob }
interface Transaction { query; sql; exec; rollback(): Promise<void>; listen; get closed(): boolean }
```
NOTE the result shape differs from Neon: PGlite returns `{ rows, fields, ... }`; Neon `neon()` returns the rows array directly.

Run on this machine (`pglite_test.mjs`) [RUN]:
```text
ready_ms 1361
PostgreSQL 18.6 (PGlite 0.5.15) on wasm32-unknown-emscripten, compiled by emcc ... 32-bit
exec results 6 CREATE,CREATE,CREATE,CREATE,CREATE,CREATE        <- the plain-SQL migration file, unchanged
requests.id (bigint identity)   number  1
requests.public_id (uuid)       string  "5e504613-..."           <- gen_random_uuid() is core in PG13+, no extension
requests.created_at (timestamptz) Date  "2026-11-07T22:24:05.517Z"
requests.aoi / meta (jsonb)     object  {"type":"Point",...}
requests.h3_cells / tags (text[]) Array ["882a100d2dfffff","882a100d25fffff"]
requests.price_usd (numeric)    string  "49.50"
tx threw: boom -> status after rollback 'new'; after commit 'quoted'
check violation: e.code 23514 (class DatabaseError, e.name 'error')
type big (9007199254740993::bigint) bigint 9007199254740993   <- int8 => number if safe, JS bigint if not
type cnt (count(*))                 number 1
type d ('2026-11-07'::date)         Date   2026-11-07T00:00:00.000Z  (UTC midnight)
pg_available_extensions (no extensions loaded): plpgsql
CREATE EXTENSION postgis -> extension "postgis" is not available
CREATE EXTENSION h3      -> extension "h3" is not available
total_ms 1397
```
PostGIS in PGlite works via the separate package (`pglite_postgis_test.mjs`) [RUN]:
```ts
import { PGlite } from '@electric-sql/pglite';
import { postgis } from '@electric-sql/pglite-postgis';
const db = await PGlite.create({ extensions: { postgis } });
await db.exec('CREATE EXTENSION IF NOT EXISTS postgis;');
```
```text
create_ms 1059
POSTGIS="3.6.2 0" [EXTENSION] PGSQL="180" GEOS="3.14.0-CAPI-1.20.4" PROJ="9.7.0 NETWORK_ENABLED=OFF ...
available: plpgsql@1.0 postgis@3.6.2 postgis_raster@3.6.2 postgis_tiger_geocoder@3.6.2 postgis_topology@3.6.2
ST_Buffer/ST_AsGeoJSON/ST_Area(geography) OK;  CREATE EXTENSION postgis_raster OK
CREATE EXTENSION h3 -> extension "h3" is not available;  h3_postgis -> not available
```
- **There is no h3 extension for PGlite.** Official catalog (`docs/extensions/extensions.data.ts`) lists: pgvector, live, amcheck, auto_explain, bloom, btree_gin, btree_gist, citext, cube, earthdistance, fuzzystrmatch, hstore, intarray, dict_xsyn, pageinspect, dict_int, unaccent, pg_surgery, pgtap, pg_uuidv7, pg_walinspect, pg_visibility, pg_freespacemap, pg_buffercache, file_fdw, isn, lo, ltree, pg_trgm, seg, tablefunc, tcn, tsm_system_rows, tsm_system_time, uuid-ossp, pg_ivm, pgcrypto, pg_hashids, Apache AGE, PostGIS, pg_textsearch, pg_stat_statements, pgmq, pg_partman, pgaudit, pg_repack, hypopg, plpgsql_check - zero matches for "h3". `npm search pglite` shows no h3 package either [RUN].
- PostGIS for PGlite is "an **external** extension, distributed as a separate package" (catalog entry, size 19,757,024 bytes, status tracked at github.com/electric-sql/pglite/issues/916).
- Built-in contrib (import from `@electric-sql/pglite/contrib/<name>`): amcheck auto_explain bloom btree_gin btree_gist citext cube dict_int dict_xsyn earthdistance file_fdw fuzzystrmatch hstore intarray isn lo ltree moddatetime pageinspect pg_buffercache pg_freespacemap pg_stat_statements pg_surgery pg_trgm pg_visibility pg_walinspect pgcrypto seg tablefunc tcn tsm_system_rows tsm_system_time unaccent uuid_ossp (from `ls dist/contrib`) [RUN].
- Persistence: `PGlite.create({ dataDir: './.pglite' })` persists to disk in Node; no `dataDir` = in-memory (ideal for tests).

Source: d.ts lines above [TYPES]; https://raw.githubusercontent.com/electric-sql/pglite/main/docs/extensions/extensions.data.ts [DOCS]; scratch scripts `pglite_test.mjs`, `pglite_postgis_test.mjs` [RUN]

### 3.6 Same plain-SQL migrations on PGlite and Neon

- PGlite 0.5.15 = PostgreSQL **18.6**; Neon's current PG18 minor = **18.6** (postgres-version-policy.md). Create the Neon project on **Postgres 18** so both run the same server version.
- Verified on PGlite [RUN]: `bigint GENERATED ALWAYS AS IDENTITY`, `uuid DEFAULT gen_random_uuid()`, `timestamptz DEFAULT now()`, `jsonb DEFAULT '{}'::jsonb`, `text[] DEFAULT '{}'`, `CHECK (... IN (...))`, `UNIQUE (...)` + `ON CONFLICT ... DO UPDATE`, GIN index on `text[]`, `&&` and `= ANY($1::text[])`, `->>` on jsonb, `count(*) OVER ()`.
- Rules for portable migrations: no `CREATE EXTENSION` (or guard it), no `SET` statements (Neon pooler is transaction mode), one file = one transaction, run migrations against the **direct** (unpooled) URL on Neon.
- Same file on Neon: [UNVERIFIED live] - expected to work (same PG major/minor, only core features used). Confirm with `node scripts/migrate.ts` once `DATABASE_URL` exists.

Starter migration that passed on PGlite [RUN] (`migrations/0001_init.sql`):
```sql
-- Portable migration: must run unchanged on PGlite 0.5.x (PostgreSQL 18.6 wasm) and Neon (PG 18).
-- No extensions. H3 cell ids are computed in app code and stored as text.

CREATE TABLE IF NOT EXISTS requests (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  public_id    uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  status       text NOT NULL DEFAULT 'new'
               CHECK (status IN ('new','quoted','confirmed','in_progress','delivered','refused','failed')),
  customer_email text,
  question     text NOT NULL,
  aoi          jsonb,                       -- GeoJSON geometry
  h3_cells     text[] NOT NULL DEFAULT '{}', -- res-8 cells covering the AOI
  tags         text[] NOT NULL DEFAULT '{}',
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_usd    numeric(10,2)
);

CREATE TABLE IF NOT EXISTS earth_index (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  h3_cell      text NOT NULL,            -- e.g. '882a100d2dfffff'
  h3_res       smallint NOT NULL CHECK (h3_res BETWEEN 0 AND 15),
  observed_on  date NOT NULL,
  metric       text NOT NULL,            -- 'ndvi_mean', 'dnbr', 'flood_frac', ...
  value        double precision,
  source       text NOT NULL,            -- 'sentinel-2-l2a', 'landsat-c2-l2', ...
  layer        text NOT NULL CHECK (layer IN ('disasters','forest','mining','inbound')),
  request_id   bigint REFERENCES requests(id) ON DELETE SET NULL,
  report_ref   text,
  props        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (h3_cell, observed_on, metric, source)
);
CREATE INDEX IF NOT EXISTS earth_index_cell_idx  ON earth_index (h3_cell);
CREATE INDEX IF NOT EXISTS earth_index_layer_idx ON earth_index (layer, observed_on DESC);
CREATE INDEX IF NOT EXISTS requests_cells_gin    ON requests USING gin (h3_cells);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
```
Note: `earth_index_cell_idx` is redundant (the UNIQUE index leads with `h3_cell`); drop it if you copy this.

Runner (`scripts/migrate.ts`), run twice against a persisted PGlite dir [RUN]:
```ts
import { getDb, migrate } from '../lib/db.ts';
const db = await getDb();
console.log(`[${db.kind}] applied:`, await migrate(db));
await db.close();
```
```text
$ PGLITE_DATA_DIR=./.pglite-test node scripts/migrate.ts
[pglite] applied: [ '0001_init.sql', '0002_providers.sql' ]
$ PGLITE_DATA_DIR=./.pglite-test node scripts/migrate.ts
[pglite] applied: []                       (persisted dataDir = 38 MB on disk; gitignore it)
```

### 3.7 Recommended DB access layer (`lib/db.ts`) - written and run [RUN]

PGlite when `DATABASE_URL` is unset, Neon when set; identical JS types from both. Runs as-is under Node 24 type stripping (`node scripts/test_db.ts`, needs `"type": "module"`).
```ts
// lib/db.ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Row = Record<string, any>;
export type Query = <T extends Row = Row>(text: string, params?: unknown[]) => Promise<T[]>;
export interface Db {
  kind: 'neon' | 'pglite';
  query: Query;                                             // one statement, $1..$n params
  exec(script: string): Promise<void>;                      // many statements, no params (migrations)
  transaction<T>(fn: (q: Query) => Promise<T>): Promise<T>; // interactive BEGIN/COMMIT, ROLLBACK on throw
  close(): Promise<void>;
}
// int8/count -> number, numeric -> number, date -> 'YYYY-MM-DD', timestamptz -> Date, jsonb -> object, text[] -> string[]
const INT8 = 20, NUMERIC = 1700, DATE = 1082;
const toNum = (v: string) => (v === null ? null : Number(v));
const asText = (v: string) => v;

async function makeNeon(url: string): Promise<Db> {
  const { neon, Pool, types: pgTypes } = await import('@neondatabase/serverless');
  // neon(url, { types }) IGNORES `types` in v1.2.0 - pass it per query (verified in driver source + run).
  const types = { getTypeParser: (oid: number, fmt?: any) =>
    oid === INT8 || oid === NUMERIC ? toNum : oid === DATE ? asText : pgTypes.getTypeParser(oid, fmt) };
  const sql = neon(url);
  const directUrl = process.env.DATABASE_URL_UNPOOLED ?? url;   // direct (no PgBouncer) for migrations
  async function withClient<T>(connStr: string, fn: (c: any) => Promise<T>): Promise<T> {
    const pool = new Pool({ connectionString: connStr, types });  // per call: create+close inside the handler
    const client = await pool.connect();
    try { return await fn(client); } finally { client.release(); await pool.end(); }
  }
  return {
    kind: 'neon',
    query: (text, params = []) => sql.query(text, params as any[], { types }) as any,      // HTTP, 1 round trip
    exec: (script) => withClient(directUrl, async (c) => { await c.query(script); }),     // simple protocol: multi-statement OK
    transaction: (fn) => withClient(url, async (c) => {
      await c.query('BEGIN');
      try { const r = await fn(async (t, p = []) => (await c.query(t, p)).rows); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }),
    close: async () => {},
  };
}

async function makePglite(dataDir?: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');   // dynamic: not loaded when DATABASE_URL is set
  const pg = await PGlite.create({ dataDir, parsers: { [INT8]: toNum, [NUMERIC]: toNum, [DATE]: asText } });
  return {
    kind: 'pglite',
    query: async (text, params = []) => (await pg.query<any>(text, params as any[])).rows,
    exec: async (script) => { await pg.exec(script); },
    transaction: (fn) => pg.transaction((tx) => fn(async (t, p = []) => (await tx.query<any>(t, p as any[])).rows)),
    close: () => pg.close(),
  };
}

const g = globalThis as any;                                   // survive Next.js dev hot reloads
export function getDb(): Promise<Db> {
  g.__terragentDb ??= process.env.DATABASE_URL ? makeNeon(process.env.DATABASE_URL) : makePglite(process.env.PGLITE_DATA_DIR);
  return g.__terragentDb;
}

// migrations/NNNN_name.sql, applied in filename order, each in one transaction
export async function migrate(db: Db, dir = 'migrations'): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(f)) continue;
    const body = await readFile(join(dir, f), 'utf8');
    try { await db.exec(`BEGIN;\n${body}\n;INSERT INTO schema_migrations(name) VALUES ('${f.replace(/'/g, "''")}');\nCOMMIT;`); }
    catch (e) { await db.exec('ROLLBACK').catch(() => {}); throw new Error(`migration ${f} failed: ${(e as Error).message}`); }
    applied.push(f);
  }
  return applied;
}
```
Output, PGlite mode (`node scripts/test_db.ts`) and Neon mode (`NEON_SHIM=1`: the real Neon driver's HTTP path, with `neonConfig.fetchFunction` answered by a PGlite backend returning raw text like `Neon-Raw-Text-Output` - OFFLINE, not a live Neon) [RUN]:
```text
backend: pglite                                   | backend: neon
migrate #1 applied: ['0001_init.sql','0002_providers.sql'];  migrate #2 applied: []   (PGlite only)
requests.id          number 1                     | number 1
requests.created_at  Date                         | Date
requests.aoi         object {"type":"Polygon",..} | object
requests.h3_cells    Array ["8928308283bffff",..] | Array
requests.price_usd   number 49.5                  | number 49.5
earth_index.observed_on string "2026-11-01"       | string "2026-11-01"
earth_index.n (count(*) OVER ()) number 1         | number 1
tx threw: boom -> status now new; tx committed -> quoted   (PGlite)
bad migration: "migration 0001_bad.sql failed: function nope_fn() does not exist"; session still usable; table x rolled back
constraint error: error 23514 ...                 | NeonDbError 23514 ...   <- branch on e.code, not e.name/class
```
Neon **Pool/WebSocket** path of the same `lib/db.ts` (`node scripts/test_db_pool.ts`): real `Pool` from `@neondatabase/serverless` 1.2.0 -> `ws://` bridge -> `@electric-sql/pglite-socket` (TCP, `maxConnections: 10`) -> PGlite, with `neonConfig.wsProxy = () => '127.0.0.1:18080/v2'; useSecureWebSocket = false; pipelineTLS = false; pipelineConnect = false` (OFFLINE, not a live Neon) [RUN]:
```text
backend: neon
migrate #1 via Pool (multi-statement simple protocol): [ '0001_init.sql', '0002_providers.sql' ]
migrate #2: []
id number 1 | created_at Date | h3_cells Array | meta object | price_usd number 12.5 | count(*) number 1 | date string "2026-11-01"
tx threw boom -> status after rollback: new
Pool error: DatabaseError 42P01 relation "nope" does not exist        <- Pool errors are node-postgres DatabaseError, HTTP errors are NeonDbError
```
So `Pool` honours `types` in its config (unlike `neon(url, {types})`), and a multi-statement string with `BEGIN; ...; COMMIT;` runs in one `client.query()`.

Live observation (accidental, dummy credentials, no account): before the HTTP shim was wired in, one `sql.query()` with the placeholder string `postgresql://postgres:x@ep-local-000000-pooler.us-east-2.aws.neon.tech/postgres` reached the real `https://api.us-east-2.aws.neon.tech/sql`, which answered HTTP 400 and the driver threw `NeonDbError: password authentication failed for user 'postgres'` (`code: ''`, `severity: ''`) [RUN, live]. Confirms the HTTP endpoint host derivation; note auth errors carry an empty `code`.

Usage:
```ts
import { getDb } from '@/lib/db';
const db = await getDb();
const rows = await db.query<{ h3_cell: string; value: number }>(
  'SELECT h3_cell, value FROM earth_index WHERE h3_cell = ANY($1::text[]) AND metric = $2', [cells, 'ndvi_mean']);
await db.query('INSERT INTO requests (question, aoi) VALUES ($1, $2)', [q, JSON.stringify(geojson)]); // ALWAYS stringify jsonb
```

### 3.8 H3 in JavaScript: `h3-js` v4 (npm package is `h3-js`; npm `h3` is an unrelated HTTP framework)

Signatures (`node_modules/h3-js/dist/types.d.ts`, v4.5.0) [TYPES]:
```ts
latLngToCell(lat: number, lng: number, res: number): H3Index;                         // d.ts:100  type H3Index = string
cellToLatLng(h3Index: H3IndexInput): CoordPair;                                        // d.ts:108  returns [lat, lng]
cellToBoundary(h3Index: H3IndexInput, formatAsGeoJson?: boolean): CoordPair[];         // d.ts:119  default [lat,lng] open ring; true => [lng,lat] closed ring
polygonToCells(coordinates: number[][] | number[][][], res: number, isGeoJson?: boolean): H3Index[]; // d.ts:232 default expects [lat,lng]!
polygonToCellsExperimental(coordinates, res, flags: string, isGeoJson?): H3Index[];    // d.ts:249
gridDisk(h3Index: H3IndexInput, ringSize: number): H3Index[];                          // d.ts:185  includes origin
getResolution(h3Index: H3IndexInput): number;                                          // d.ts:77
cellArea(h3Index: H3IndexInput, unit: string): number;                                 // d.ts:451  unit 'm2'|'km2'|'rads2'
isValidCell, cellToParent(h, res), cellToChildren(h, res), cellsToMultiPolygon(hs, formatAsGeoJson?), compactCells, uncompactCells,
getHexagonAreaAvg(res, unit), getHexagonEdgeLengthAvg(res, unit), greatCircleDistance(a, b, unit)
UNITS = { m:'m', m2:'m2', km:'km', km2:'km2', rads:'rads', rads2:'rads2' }
POLYGON_TO_CELLS_FLAGS = { containmentCenter, containmentFull, containmentOverlapping, containmentOverlappingBbox }  (string values = names)
type H3IndexInput = string | number[];   type CoordPair = [number, number];   H3Error = { message: string; code: number }
```
Run (`h3_test.mjs`) [RUN]:
```text
latLngToCell(37.7749,-122.4194,8) = 8828308281fffff string
cellToLatLng -> [ 37.77351509723815, -122.41827103692466 ]              ([lat,lng])
cellToBoundary default: n=6 first=[37.7688..,-122.4168..]                (lat,lng; open ring)
cellToBoundary geojson: n=7 first=[-122.4168..,37.7688..] closed=true    (lng,lat; first==last)
getResolution 8; isValidCell true / isValidCell('nope') false
gridDisk(cell,1) n=7 includesSelf=true; k=2 n=19
cellArea m2 765817.3, km2 0.7658
polygonToCells(~1.1x1.1 km box) res7: 0 cells, res8: 1, res9: 9   (geojson flag and [lat,lng] input give identical sets)
polygonToCells(GeoJSON coords WITHOUT isGeoJson=true) res9 = 0         <- silent wrong result, no error
polygonToCellsExperimental(..., containmentOverlapping, true) res8 = 4
cellToParent(res6) 86283082fffffff; cellToChildren(res9) 7
latLngToCell(..., 16) throws Error code 4 "Resolution argument was outside of acceptable range (code: 4)"
cellToLatLng('zzz') -> [79.24.., 38.02..]   NO THROW (garbage); getResolution('zzz') -> -1
uppercase '8828308281FFFFF' accepted (isValidCell true)
polygonToCells(California bbox, res7) = 196,937 cells in 418 ms; compactCells -> 2,843
```
- Use `polygonToCells(geojsonPolygon.coordinates, res, true)` - `coordinates` of a GeoJSON Polygon is already `number[][][]` (outer ring + holes).
- AOIs smaller than a cell return **0 cells** with the default center-containment: fall back to `latLngToCell(centroid)` or use `polygonToCellsExperimental(..., POLYGON_TO_CELLS_FLAGS.containmentOverlapping, true)`.

Source: dist/types.d.ts [TYPES]; https://raw.githubusercontent.com/uber/h3-js/master/README.md (API Reference) [DOCS]

### 3.9 H3 in Python: `h3` v4 (`pip install h3`, 4.5.0)

Run (`pyscripts/h3_test.py` in a venv, `python -I`) [RUN]:
```text
h3 4.5.0
latlng_to_cell(37.7749,-122.4194,8) -> 8828308281fffff str          <- identical id to h3-js
cell_to_latlng -> (37.773515097238146, -122.41827103692466)           (lat,lng) tuple
cell_to_boundary n=6 first=(37.7688.., -122.4168..)                   (lat,lng) tuples, open ring, NO geo_json flag in v4
get_resolution 8; is_valid_cell True / False
grid_disk k=1 n=7 list
cell_area m^2 765817.3, km^2 0.7658                                    <- units are 'm^2'/'km^2' (JS uses 'm2'/'km2')
polygon_to_cells(LatLngPoly([(lat,lng),...]), 9) -> 9
geo_to_cells({'type':'Polygon','coordinates':[ring_lnglat]}, 9) -> 9   <- takes GeoJSON dict (lng,lat) directly
cells_to_geo(cells) -> {'type': 'Polygon', 'coordinates': ...}
average_hexagon_edge_length(8, unit='m') 531.4; average_hexagon_area(8, unit='km^2') 0.737328
cell_to_latlng('zzz') raises ValueError; latlng_to_cell(..., 16) raises H3ResDomainError
signatures: latlng_to_cell(lat, lng, res); cell_to_latlng(h); cell_to_boundary(h); polygon_to_cells(h3shape, res);
            geo_to_cells(geo, res); grid_disk(h, k=1); get_resolution(h); cell_area(h, unit='km^2');
            average_hexagon_edge_length(res, unit='km'); average_hexagon_area(res, unit='km^2')
int API: h3.api.basic_int.latlng_to_cell(...) -> 613196570331971583 (= 0x8828308281fffff); h3.str_to_int / h3.int_to_str
```
JS <-> Python name map: latLngToCell/latlng_to_cell, cellToLatLng/cell_to_latlng, cellToBoundary/cell_to_boundary, polygonToCells/polygon_to_cells (LatLngPoly) or geo_to_cells (GeoJSON), gridDisk/grid_disk, getResolution/get_resolution, cellArea/cell_area, getHexagonEdgeLengthAvg/average_hexagon_edge_length, getHexagonAreaAvg/average_hexagon_area.

Source: `inspect.signature` on installed package [RUN]; https://raw.githubusercontent.com/uber/h3-py/master/docs/api_quick.md [DOCS]

### 3.10 H3 resolutions 6-9 (h3-js output == official table at https://h3geo.org/docs/core-library/restable)

| res | avg hexagon area | avg edge length | cell ~covers | use in Terragent |
|---|---|---|---|---|
| 6 | 36.129062 km2 | 3.724533 km | a small town | regional rollups, globe zoomed out |
| 7 | 5.161293 km2 | 1.406476 km | a neighbourhood | forest / mining layers |
| 8 | 0.737328 km2 | 0.531414 km (531 m) | several city blocks | default Earth-index key; disasters |
| 9 | 0.105333 km2 | 0.200786 km (201 m) | a block / large parcel | property-level inbound answers |
(Sentinel-2 10 m pixel: a res-9 cell is ~1,050 pixels, res-8 ~7,370.) Neon's h3 doc says res 8 edge "~461 meters" - that is the old v3 table value; v4 table and h3-js agree on 531 m.

### 3.11 Recommendation: compute H3 in app code, store cell ids as `text`

Decision: **do not use the Neon h3/h3_postgis/postgis extensions for the MVP.** Compute cells with `h3-js` (Next.js/Node) or `h3` (Python sandbox) and store the 15-char lowercase hex string in `text` / `text[]` columns.
1. Portability: PGlite has PostGIS (20 MB add-on) but **no h3**; an `h3index` column or `h3_*` function makes every local test and CI run need a live Neon branch.
2. Same ids everywhere: h3-js and Python h3 produce identical strings (verified `8828308281fffff`), and the globe can render them with h3-js `cellToBoundary(cell, true)` in the browser (deck.gl's `H3HexagonLayer` also takes hex strings - [UNVERIFIED] here).
3. Fewer moving parts: no `CREATE EXTENSION` (h3_postgis needs postgis + postgis_raster via CASCADE), no h3-pg rename trap (`h3_lat_lng_to_cell` vs `h3_latlng_to_cell` between 4.1.3 and 4.2.3).
4. What we lose is small at our scale: spatial joins in SQL. Do them in app code: `cells = polygonToCells(aoi, 8, true)` then `WHERE h3_cell = ANY($1::text[])` (B-tree index) or `h3_cells && $1::text[]` (GIN on text[]). Parents for rollups: store `h3_res` and compute `cellToParent` in app, or add a `h3_r6 text` column at insert time.
5. Escape hatch: if we later need SQL-side geo, `CREATE EXTENSION h3; CREATE EXTENSION h3_postgis CASCADE;` on Neon and cast `h3_cell::h3index` - text ids remain valid input.
Rules: always `isValidCell()` before storing (h3-js `cellToLatLng` does not throw on garbage), store lowercase, store `h3_res` alongside.


## 4. Discrepancies with the master prompt

| # | Spec says | Reality (verified) | Impact on the build |
|---|---|---|---|
| 1 | 3.4: "Check whether Neon supports the PostGIS and h3 extensions; if not, compute H3 cells in application code and store cell IDs as text." | Neon **does** support them: PG18 `postgis 3.6.4`, `postgis_raster 3.6.4`, `h3 4.2.3`, `h3_postgis 4.2.3` (needs postgis + postgis_raster, use `CASCADE`); no plan restriction (only `pg_repack` is paid-only). Source: neon.com/docs/extensions/pg-extensions.md | Still compute H3 in app code and store `text` (section 3.11), because PGlite (our no-Docker test DB) has **no h3 extension**. The extension is an optional later upgrade. |
| 2 | 3.4: "Grid the planet with H3 (the `h3` library)" | On npm, `h3` is an unrelated HTTP framework (`h3@2.0.8`, "Minimal H(TTP) framework"). The JS binding is **`h3-js`** (4.5.0). On PyPI the binding is `h3` (4.5.0). | `npm install h3-js`, never `npm install h3`. Python: `pip install h3`. |
| 3 | 1.1: "Neon credits $250" | Free plan is hard-capped: 100 CU-hours/project/month, 1 GB storage/project, 5 GB egress/project, scale-to-zero after 5 min (cannot disable), max 2 CU. When CU-hours run out "your compute is suspended until the next billing period". Paid Launch = $0.106/CU-hour, $0.35/GB-month. How the $250 credit is applied (which plan) is not documented in the pages read. | Free plan is enough for a 22-hour build if max compute is kept small (0.25 CU always-on = 6 CU-h/day). If credits put us on Launch, we can disable scale-to-zero for the demo. Founders: confirm which plan the credits land on. |
| 4 | 3.4 / 7: "Neon Postgres" | Neon now brands its database "Lakebase Postgres ... from Databricks" (neon.com/llms.txt). Console (`console.neon.tech`), npm package and connection-string hosts (`*.aws.neon.tech`) are unchanged. | None for code. Expect "Lakebase" wording in Neon docs/console. |
| 5 | 3.4: "about resolution 7-9" | Fine. Avg edge: res7 1.406 km, res8 531 m, res9 201 m (h3-js == h3geo.org table). Neon's h3 doc says res 8 is "~461 meters" (old v3 figure). | Use the table in 3.10; default Earth-index key res 8. |
| 6 | (implicit) Neon h3 docs as reference | Neon's example calls `h3_lat_lng_to_cell`, but h3-pg 4.2.3 (Neon's PG18 build) renamed `lat_lng` -> `latlng` (`h3_latlng_to_cell`). | Only matters if someone uses the extension; another reason to stay in app code. |
| 7 | 7: "Webhooks from Naive and AgentMail keep the database current" (Vercel functions) | Neon docs: use the **pooled** string for serverless; `neon()` HTTP for one-shot queries; a `Pool` must be created and closed inside each request handler (`after()` / `waitUntil()`). HTTP `transaction()` is non-interactive. | Webhook handlers use `db.query` (HTTP). Read-modify-write flows use `db.transaction` (Pool, per request). Migrations use `DATABASE_URL_UNPOOLED`. |

## 5. Answers to open questions (spec section 14)

| Question | Answer | Confidence | Source |
|---|---|---|---|
| Does Neon support the PostGIS and h3 extensions on our plan? | **Yes, on every plan including Free.** PG18: postgis 3.6.4, postgis_raster 3.6.4, h3 4.2.3, h3_postgis 4.2.3 (PG17: postgis 3.5.7, h3 4.1.3). Enable with `CREATE EXTENSION IF NOT EXISTS h3 CASCADE; CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE;`. The extensions page marks only `pg_repack` as paid-only. **But we recommend not using them** (section 3.11). | Medium-high (official docs, not run against a live Neon project) | https://neon.com/docs/extensions/pg-extensions.md (2026-11-04); https://neon.com/docs/extensions/postgis-related-extensions.md |
| (related) Can tests run without Neon or Docker? | Yes: PGlite 0.5.15 (PostgreSQL 18.6 in WASM, in-process) ran the same plain-SQL migrations, jsonb / timestamptz / text[] / identity / uuid, transactions, ON CONFLICT [RUN]. PostGIS 3.6.2 loads via `@electric-sql/pglite-postgis`; h3 does not exist for PGlite. | High | section 3.5-3.7 |

The other section-14 questions (Naive models, inbound email wake-up, imagery prices, sponsor criteria, pitch format) are outside this topic.

Confirm once `DATABASE_URL` exists (one query, ~1 s):
```sql
SELECT version();
SELECT name, default_version, installed_version FROM pg_available_extensions
 WHERE name IN ('postgis','postgis_raster','h3','h3_postgis') ORDER BY name;
```

## 6. Credentials needed

| Env var | Service | Where to get it (a human does this) | Cost | Needed for |
|---|---|---|---|---|
| `DATABASE_URL` | Neon (pooled, host has `-pooler`) | Neon Console -> project -> **Connect** -> Connection pooling ON -> copy. Or add Neon from the Vercel Marketplace, which injects it into the Vercel project automatically. Choose **Postgres 18** when creating the project (matches PGlite 18.6). | Free plan $0 (or the $250 credits) | All app queries on Vercel; webhook handlers; Node scripts. Unset => code falls back to PGlite. |
| `DATABASE_URL_UNPOOLED` | Neon (direct) | Same Connect modal with pooling OFF (Vercel integration injects it under this exact name). | same | `migrate()` / `pg_dump` / admin. Falls back to `DATABASE_URL` if unset. |
| `PGLITE_DATA_DIR` | none (local path, not a secret) | e.g. `./.pglite` (gitignore it) | free | Optional: persist the local PGlite DB between runs; unset = in-memory. |
| `NEON_API_KEY` | Neon management API | Neon Console; see https://neon.com/docs/reference/api/get-started.md ("Create an API key") | free | Optional, only to change `suspend_timeout_seconds` through the API (paid plans). Not needed for the MVP. |

No keys are needed for h3-js, Python h3, or PGlite. Per spec 0/7, also store `DATABASE_URL` in the Naive vault if agents ever talk to the DB directly (recommendation: they call our API instead, see 7.4). (critic-verified, Naïve identity/vault.md) That vault option doesn't exist. The Naïve vault injects only into MCP-server connections, and the `env_var` kind that would expose `DATABASE_URL` to a sandbox answers `501 feature_not_configured`. `DATABASE_URL` lives only in `.env` and Vercel env.

## 7. Gotchas & limits

### 7.1 Neon Free plan (https://neon.com/docs/introduction/plans.md, Last updated 2026-11-04) [DOCS]
| Item | Free | Launch (paid) |
|---|---|---|
| Price | $0/month | pay as you go, $0.106/CU-hour |
| Compute | 100 CU-hours/project/month ("enough to run a 0.25 CU compute ... for 400 hours/month") | metered |
| Autoscaling max | 2 CU (8 GB RAM) | 16 CU |
| Scale to zero | after 5 min, **cannot disable** | after 5 min, can disable |
| Storage | 1 GB/project, 20 GB account total | $0.35/GB-month |
| Egress | 5 GB/project/month | 500 GB then $0.10/GB |
| Projects / branches | 100 / 10 per project | 100 / 10 |
| History (instant restore) | 6 h, up to 1 GB changes | up to 7 days |
- Over the Free limit: out of CU-hours or egress -> **compute suspended until next billing period**; over storage -> INSERT/UPDATE/DELETE fail. No data deleted.
- Cold start after scale-to-zero: "reactivates automatically within a few hundred milliseconds" (scale-to-zero.md). connection-latency.md recommends ~10 s connection timeouts and retries with exponential backoff; the driver docs show `async-retry` around `sql\`...\``.
- Budget math: compute time = CU x hours awake. Overnight cron touching the DB every <5 min keeps it awake: 0.25 CU x 24 h = 6 CU-h/day; at 2 CU it is 48 CU-h/day (half the monthly Free allowance in two days). Cap autoscaling max at 0.25-1 CU in the Console.

### 7.2 Neon driver traps (all verified on 1.2.0)
1. `sql('SELECT ...')` throws; use `` sql`...${v}` `` or `sql.query('... $1', [v])`.
2. `neon()` returns **rows only** (array). `{ fullResults: true }` gives `{ command, rowCount, rowAsArray, fields, rows }`.
3. Default types: int8 (`bigint`, `count(*)`) -> **string**, numeric -> string, date -> JS `Date` at **local** midnight (e.g. `2026-11-07T08:00:00.000Z` on a PST machine), timestamptz -> Date, jsonb -> object, text[] -> array, int4/float8 -> number, bool -> boolean.
4. `neon(url, { types })` **ignores** `types` (constructor destructures only arrayMode, fullResults, fetchOptions, isolationLevel, readOnly, deferrable, authToken, disableWarningInBrowsers; parsing reads only per-query `types`). Works: `sql.query(q, p, { types })`, `new Pool({ types })`, or global `types.setTypeParser(oid, fn)` exported from the package.
5. **jsonb params: always `JSON.stringify`.** The driver turns a JS array into a Postgres array literal (`[1,2]` -> `{"1","2"}`), which fails as jsonb (`invalid input syntax for type json`); plain objects are stringified correctly. **PGlite accepts raw arrays for jsonb, so local tests will not catch this.**
6. HTTP `transaction()` is a single non-interactive batch (no reading a result mid-transaction). Interactive = `Pool`/`Client`.
7. Pooler is PgBouncer **transaction mode**: no `SET`, `LISTEN/NOTIFY`, SQL `PREPARE`, session advisory locks. 10,000 client connections; per-user/db pool = 90% of `max_connections`; waits 2 min then errors.
8. HTTP request/response max **64 MB**: page large Earth-index reads.
9. Errors: HTTP -> `NeonDbError` (`.code` = SQLSTATE; auth failures have `code: ''`); Pool -> node-postgres `DatabaseError`; PGlite -> `DatabaseError` with `e.name === 'error'`. Branch on `e.code` (e.g. `23505` unique, `23514` check).
10. Vercel: Node 22/24/26 available, 26.x default (vercel.com/docs/functions/runtimes/node-js/node-js-versions.md) - all have global `WebSocket`, so no `ws` needed for `Pool`.

### 7.3 PGlite traps (0.5.15)
1. "PGlite is single user/connection" (README Limitations). Queries are serialized in-process. Do not open the same `dataDir` from two processes (e.g. `next dev` and a script) at once [multi-process behaviour UNVERIFIED - just avoid it].
2. int8 -> `number` when safe, **JS `bigint` when > 2^53** (`9007199254740993n`), and `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt` [RUN]. Use the `parsers` in 3.7 or keep ids < 2^53.
3. date -> `Date` at **UTC** midnight (Neon: local midnight). numeric -> string. Normalize with parsers (3.7) or return dates as text.
4. Start-up ~1.0-1.4 s per instance [RUN]; create one per test file, in-memory.
5. Package is 26 MB; PostGIS add-on 20 MB and its peer dependency pins the exact pglite version (`0.5.15`). Keep both as devDependencies and load PGlite with dynamic `import()` so Vercel functions never load it.
6. No h3 extension exists for PGlite (catalog + npm search) - another reason for app-side H3.
7. pglite-socket (if you want `psql` against PGlite) defaults to **max connections: 1**; set `maxConnections` [RUN].

### 7.4 H3 traps
1. **Coordinate order.** `latLngToCell(lat, lng, res)`; `cellToLatLng` -> `[lat, lng]`; GeoJSON is `[lng, lat]`. `polygonToCells(coords, res)` expects `[lat, lng]` unless the 3rd arg `isGeoJson = true`. Passing GeoJSON coords without the flag silently returns 0 cells (no error) [RUN].
2. `cellToBoundary(h)` = 6 (or up to 10) `[lat,lng]` open ring; `cellToBoundary(h, true)` = `[lng,lat]` closed ring (7 points) ready for GeoJSON [RUN]. Python v4 `cell_to_boundary(h)` has no GeoJSON flag; use `h3.cells_to_geo([h])`.
3. Small AOIs: center-containment returns 0 cells when the polygon is smaller than a cell (1.1 km box at res 7 -> 0, res 8 -> 1) [RUN]. Fallback: `[latLngToCell(centroid)]` or `containmentOverlapping`.
4. Big AOIs explode: California bbox res 7 = 196,937 cells in 0.42 s; res 9 = 9,649,673 cells in 12.2 s [RUN]. Estimate first: `areaKm2 / getHexagonAreaAvg(res,'km2')`; refuse or drop resolution above ~50k cells; store `compactCells()` output for coverage.
5. h3-js `cellToLatLng('zzz')` returns garbage coordinates instead of throwing; `getResolution('zzz')` = -1. Python raises `ValueError`. Always `isValidCell()` on input from agents/LLMs. Uppercase hex is accepted, so `toLowerCase()` before storing (text equality).
6. Units: JS `'m2'|'km2'|'m'|'km'|'rads'|'rads2'` (or `h3.UNITS.*`). Python `cell_area` takes `'m^2'|'km^2'|'rads^2'` (`'m2'` raises `ValueError: Unknown unit: m2`); Python `average_hexagon_edge_length` takes only `'m'|'km'` (`'rads'` raises) [RUN].
7. Bad resolution: JS throws `Error` with `code: 4`; Python raises `H3ResDomainError`.
8. Design recommendation (not a platform fact): Naive agents (Python sandbox) should send derived results to our API (`POST /api/earth-index`), which validates cells and writes to Neon, rather than holding DB credentials. (critic) Calling that HTTP API from the sandbox would need a bearer token in the command, which ends up in the 30-day command history and in model context. Use one of these instead:
   - (a) a Terragent **MCP tool** (`earth_index_write`), authenticated by the vault-injected `TERRAGENT_MCP_TOKEN`;
   - (b) the agent's `structured_output`, which our backend writes to Neon on the `session.idle` webhook (`data.structured_output` is in the envelope, naive-orchestration.md §3.5).

## 8. Unverified

| Item | Why unverified | How to confirm once keys exist |
|---|---|---|
| The migrations in this doc run unchanged on a live Neon PG18 project | No Neon account/key (rule: no sign-ups). Verified only on PGlite 18.6 and through the real driver against offline shims. | `DATABASE_URL=... DATABASE_URL_UNPOOLED=... node scripts/migrate.ts` (calls `migrate(await getDb())`), then `\d earth_index`. |
| postgis/h3/h3_postgis actually installable on *our* project/plan | Docs only | `CREATE EXTENSION IF NOT EXISTS h3 CASCADE; CREATE EXTENSION IF NOT EXISTS h3_postgis CASCADE; SELECT h3_latlng_to_cell(POINT(-122.4194, 37.7749), 8);` (h3-pg `point` is (lng, lat) - also unverified), then drop if unused. |
| Real Neon HTTP response JSON for success (`fields`, `rows` as text arrays, `rowCount`, `command`) | Inferred from driver source (`hs()` parser, `Neon-Raw-Text-Output: true`, `Neon-Array-Mode: true`) and replayed through a shim. Only a live 400 error was observed. | Run `scripts/test_db.ts` with a real `DATABASE_URL`; output types must match the PGlite column in 3.7. |
| Whether multi-statement strings work over the HTTP `neon()` path | Not tested live; `lib/db.ts` deliberately routes `exec()` through `Pool` (simple protocol, verified offline). | `await sql.query('SELECT 1; SELECT 2')` against a live DB. |
| Cold-start latency in practice ("a few hundred milliseconds") and region choice | Docs statement only | Time the first query after >5 min idle from a Vercel function; create the Neon project in the same region as Vercel functions (default Vercel region iad1/us-east-1 - check Vercel project settings). |
| How the $250 Neon credits are applied (Free vs Launch plan) | Not in the docs pages read | Founders check Neon Console -> Billing after redeeming. |
| Neon HTTP/statement timeouts and per-query limits other than 64 MB | Not found in the pages read | Neon docs search "statement_timeout"; test a long query. |
| PGlite with the same `dataDir` opened by two processes | Not tested | Avoid; or test with two `node` processes. |
| Next.js bundling of PGlite (`serverExternalPackages`) | Not tested in a Next.js app | `next build` with `lib/db.ts`; if it bundles PGlite WASM, add `serverExternalPackages: ['@electric-sql/pglite']`. |
| deck.gl `H3HexagonLayer` accepts these string ids directly | Out of scope here | Check deck.gl docs when building the globe. |
| Python access from the Naive sandbox (psycopg over TCP 5432 to Neon) | Sandbox egress not tested; no Neon key | If needed: `pip install "psycopg[binary]"`, `psycopg.connect(os.environ['DATABASE_URL'])`. Prefer the API route in 7.4.8. |
