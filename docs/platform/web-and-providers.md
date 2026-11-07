# Web stack and paid imagery providers: verified reference

Researched 2026-11-07. Evidence comes from three places:

- npm and PyPI registries (`npm view`, PyPI JSON).
- `.d.ts` files of packages installed in a scratch dir.
- Official docs fetched as raw `.md` or `llms.txt` where available, plus live requests (trimmed responses below).

A throwaway Next 16.4.5 app was built in scratch to test the globe component, the MCP route and the `/answer` route:

- `next build` passes, including type-check. `tsc --noEmit` passes.
- The globe rendered in a browser.
- The MCP route was called with curl.

Anything not checked this way is in §8.

---

## 1. TL;DR for builders

- **Next 16.4.5 + Tailwind 4.3.5 are already scaffolded** with create-next-app defaults (Turbopack, `@tailwindcss/turbopack` loader, `src/`, `@/*`). create-next-app has no `--turbopack` flag any more: Turbopack is the default and `--rspack` is the alternative. Read `node_modules/next/dist/docs/` before writing Next code (repo `AGENTS.md`).
- **Globe: use `react-globe.gl@2.38.0` + `h3-js@4.5.0`.** Render H3 cells with the **hexbin layer**: pass one point per cell centre and set `hexBinResolution` to the display resolution (three-globe calls `latLngToCell` internally). Use `hexBinMerge` for thousands of cells. Load it with `next/dynamic` and `ssr:false` **from a `"use client"` file**. If you skip that, `next build` fails with `ReferenceError: window is not defined` (verified).
- **Aggregate to res 3–5 for the world view.** Res 7–9 cells (5.2 km² down to 0.1 km²) are invisible from orbit.
- **MCP server: `mcp-handler@2.3.1` + `@modelcontextprotocol/server@2.4.0` + `zod@^4.2`.** Do **not** install `@modelcontextprotocol/sdk` (that is v1, used by mcp-handler 1.x). The route is `src/app/api/mcp/route.ts`. Use `createMcpHandler(server => server.registerTool(name, {inputSchema: z.object(...)}, cb))`, wrap it in `withMcpAuth(handler, verifyToken, {required:true})`, and `export { h as GET, h as POST }`. The tool callback reads the caller from `ctx.http?.authInfo`.
- **MCP clients must send `Accept: application/json, text/event-stream`.** Without it the server returns 406. GET returns 405 because the server is stateless and has no SSE.
- **Vercel Hobby limits:** functions run up to **300 s** (Fluid compute, the default) with a **4.5 MB** request/response body. Legacy Cron Jobs run **once a day** on Hobby, so use Naïve cron. **Hobby is "non-commercial personal use only"** (§4).
- **Rate limiting:** a single-statement Postgres upsert into the existing `rate_limits` table (fixed hourly window). Verified on PGlite against `db/migrations/001_init.sql`.
- **Paid imagery: SkyWatch runs a public MCP server** at `https://mcp.skywatch.com/mcp`. Its `get_offerings` and `calculate_pricing` tools return live $/km² and minimum orders **with no account**. Give the Orchestrator this server for price comparisons (verified live).
- **UP42 publishes "from" prices per collection in its docs**; exact estimates need an authenticated API call. **Arlula has pivoted** to B2B infrastructure ("Geostack") and publishes no price list (contact hello@arlula.com).
- **Licences:** UP42's EULA guidance says original and value-added products (crops of the actual image) **cannot be shared with customers**. Only derivative products where no original pixels remain are usually OK. Paid-imagery reports must show derived maps and measurements, not the purchased pixels.
- **Stripe Payment Links need no server to share.** Detecting payment automatically needs a webhook route or polling with a Stripe key. Pass `?client_reference_id=req_xxx` to tie a payment to a request.

---

## 2. Install and setup (versions checked with `npm view`, 2026-11-07)

| Package | Verified version | Notes |
|---|---|---|
| `next` / `create-next-app` / `eslint-config-next` | 16.4.5 | repo already on 16.4.5 |
| `react` / `react-dom` | 19.3.1 (repo pins 19.3.0 from template) | |
| `tailwindcss` / `@tailwindcss/turbopack` / `@tailwindcss/postcss` | 4.3.5 | repo uses `@tailwindcss/turbopack` via `next.config.ts` `turbopack.rules` |
| `react-globe.gl` | 2.38.0 | deps: `globe.gl ^2.46` (2.46.2), which depends on `three-globe` 2.45.6 and `three >=0.179 <1` (0.187.0). Peer: `react: *` |
| `h3-js` | 4.5.0 | also a dependency of three-globe and deck.gl geo-layers |
| `@types/three` | 0.187.0 | optional; type-check passed with and without it (`skipLibCheck: true`) |
| `mcp-handler` | 2.3.1 | peer: `next >=13`, `@modelcontextprotocol/server ^2.0.0`; Node ≥20 |
| `@modelcontextprotocol/server` | 2.4.0 | peer `zod ^4.2.0`; depends on `@modelcontextprotocol/core` 2.4.0 |
| `@modelcontextprotocol/sdk` | 1.32.2 | **v1. Do not use with mcp-handler 2.x** |
| `zod` | 4.6.7 | |
| `@neondatabase/serverless` | 1.2.0 | `neon(url)` tagged-template HTTP driver |
| `stripe` (optional) | 23.1.0 | only if webhooks or polling are automated |
| deck.gl (`@deck.gl/core`, `/layers`, `/geo-layers`, `/react`) | 9.4.1 | alternative globe, not recommended |
| `cesium` / `resium` | 1.147.0 / 1.28.0 | not recommended |
| PyPI: `up42-py` / `arlulacore` / `planet` | 4.3.0 / 4.0.1 / 3.7.0 | provider SDKs, only if we ever order |

```bash
# from repo root (Next/Tailwind already installed)
npm i react-globe.gl@2.38.0 h3-js@4.5.0 \
      mcp-handler@2.3.1 @modelcontextprotocol/server@2.4.0 zod@^4.2.0 \
      @neondatabase/serverless@1.2.0
npm i -D @types/three@0.187.0      # optional
mkdir -p public/globe && cp node_modules/three-globe/example/img/{earth-night.jpg,earth-topology.png,night-sky.png} public/globe/
```

The textures ship inside the `three-globe` npm package (`"files": ["dist/**/*","example/**/*"]`, MIT): earth-night.jpg is 715 KB, earth-dark.jpg 95 KB, night-sky.png 904 KB. Serving them from `public/` removes a CDN dependency during the live demo. As a fallback, `https://unpkg.com/three-globe@2.45.6/example/img/earth-night.jpg` returned HTTP 200 (live).

create-next-app flags, for reference. They match what the repo already has, so don't re-run.

```bash
npx create-next-app@16.4.5 terragent --ts --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
# real flags (from --help): --ts --js --tailwind --react-compiler --cache-components --eslint --biome --app
#   --src-dir --rspack --import-alias --api --empty --use-npm|pnpm|yarn|bun --skip-install --yes
#   --agents-md (default) --disable-git.   No --turbopack / --no-turbopack flag exists.
```

Source: `create-next-app@16.4.5 --help`. The `dist/index.js` template logic writes `turbopack.rules["*.css"].loaders=["@tailwindcss/turbopack"]` and adds the `@tailwindcss/turbopack` devDependency when Tailwind is used with Turbopack.

---

## 3. API reference

### 3.1 Next.js 16 essentials used here

```ts
// any route.ts / page.tsx / layout.tsx
export const maxDuration = 300;        // seconds; Hobby max (see 3.2)
import { after } from "next/server";   // run work after the response is sent (uses Vercel waitUntil)
```
Source: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/maxDuration.md`; `.../04-functions/after.md` (lines 50, 250: `after` runs for the route's max duration and uses `waitUntil`).

`next/dynamic` with `{ ssr: false }` is only allowed in Client Components. In a Server Component it errors: "`ssr: false` is not allowed with `next/dynamic` in Server Components."
Source: `node_modules/next/dist/docs/01-app/02-guides/lazy-loading.md` lines 62–95.

### 3.2 Vercel Hobby limits (relevant subset)

| Limit | Hobby value | Source |
|---|---|---|
| Function max duration (Fluid compute, **default for new projects since 2025-04-23**) | **300 s default and max** (Pro: 300 s default, 800 s max, 1800 s beta) | https://vercel.com/docs/functions/limitations.md §Max duration; https://vercel.com/docs/fluid-compute.md line 58 |
| Function max duration without Fluid | not listed in current docs; the docs only link a changelog titled "Vercel Functions for Hobby can now run up to 60 seconds" | https://vercel.com/docs/functions/configuring-functions/duration.md (related links) |
| Timeout response | 504 `FUNCTION_INVOCATION_TIMEOUT` | limitations.md |
| Request/response body | **4.5 MB**, else 413 `FUNCTION_PAYLOAD_TOO_LARGE` | limitations.md §Request body size |
| Memory/CPU | 2 GB / 1 vCPU | limitations.md |
| Edge runtime | must start responding within 25 s, can stream for up to 300 s | limitations.md |
| Proxied request timeout (rewrites to an external origin) | 120 s | https://vercel.com/docs/limits.md General limits |
| Cron Jobs (legacy `vercel.json` crons) | 100 per project, **once per day max**, ±59 min precision; more frequent expressions fail the deploy | https://vercel.com/docs/cron-jobs/usage-and-pricing.md |
| Vercel Schedules (beta replacement) | most frequent: every 15 min (15-min jitter); 5,000 runs per billing period | https://vercel.com/docs/schedules/limits.md |
| Included monthly usage | 1M function invocations, 4 active-CPU hours, 360 GB-hrs provisioned memory, 100 GB Fast Data Transfer, 10 GB Fast Origin Transfer, 1M CDN requests | https://vercel.com/docs/plans/hobby.md |
| Over the limit on Hobby | feature paused, "wait until 30 days have passed" | plans/hobby.md §Hobby billing cycle |
| Deployments | 100/day; 100 builds/hour; 1 concurrent build; 45-min build max | limits.md |
| Runtime logs | 1 hour retention | plans/hobby.md comparison table |
| Git | Hobby cannot connect repos owned by a Git **organization** (`lapark714/terragent` is a personal account, so this is fine) | limits.md §Connecting a project to a Git repository |
| Commercial use | "**Hobby teams are restricted to non-commercial personal use only**". Commercial includes "any method of requesting or processing payment from visitors of the site" | https://vercel.com/docs/limits/fair-use-guidelines.md §Commercial usage |
| Deployment Protection | Standard Protection covers every URL **except production domains**, so the generated per-deployment URLs return an auth wall | https://vercel.com/docs/deployment-protection.md lines 61–104 |

Implication for the ~2-minute live demo: a synchronous request would fit inside 300 s, but don't hold one HTTP request open for the whole pipeline. `POST /answer` should return `202 {request_id}` and the client should poll `GET /answer/{id}`, or watch the dashboard.

### 3.3 Globe (recommended: react-globe.gl with the hexbin layer)

**Why this one:**

- **react-globe.gl:** the atmosphere, night texture, auto-rotate and point markers come out of the box. The H3 path is built in, and it was verified to build and render here.
- **deck.gl:** its `H3HexagonLayer` takes H3 ids directly, but `_GlobeView` is still exported with an underscore (experimental). It has no atmosphere or earth texture, so you'd need extra layers for land.
- **Cesium:** needs its static assets copied into `public/`, `CESIUM_BASE_URL` set, and a Cesium ion token for the default imagery. Not tested here.

Prop surface (from `react-globe.gl/dist/react-globe.gl.d.ts`, v2.38.0):

```ts
// container/globe (lines 47–66)
width, height, backgroundColor, backgroundImageUrl, globeImageUrl, bumpImageUrl, showAtmosphere,
atmosphereColor, atmosphereAltitude, showGraticules, globeMaterial, onGlobeReady, onGlobeClick
// points (68–80)
pointsData: object[]; pointLat; pointLng; pointColor; pointAltitude; pointRadius; pointsMerge; pointLabel; onPointClick
// polygons (107–121)
polygonsData; polygonGeoJsonGeometry; polygonCapColor; polygonSideColor; polygonStrokeColor; polygonAltitude; polygonLabel; onPolygonClick
// hex bin (158–174) — H3-based aggregation of POINTS
hexBinPointsData; hexBinPointLat; hexBinPointLng; hexBinPointWeight; hexBinResolution /*0–15, default 4*/;
hexMargin; hexAltitude; hexTopColor; hexSideColor; hexBinMerge; hexTransitionDuration; hexLabel; onHexClick; onHexHover
interface HexBin { points: object[]; sumWeight: number; center: { lat: number; lng: number } } // runtime also has h3Idx
// hexed polygons (176–190) — tiles a GeoJSON POLYGON with H3 dots/hexes; NOT for rendering a list of cells
hexPolygonsData; hexPolygonResolution; hexPolygonColor; hexPolygonMargin; hexPolygonUseDots
// methods via ref (293–316)
pointOfView(pov?, ms?); controls() /*OrbitControls*/; scene(); camera(); renderer(); pauseAnimation(); resumeAnimation()
// ref type (318): React.MutableRefObject<GlobeMethods | undefined>
```

Choosing the H3 rendering mode:

- **`hexBinPointsData`** draws exact H3 cells. Pass the cell centres with `hexBinResolution` set to the display resolution. three-globe does `latLngToCell(lat, lng, hexBinResolution)`, then `cellToBoundary(h3Idx, true).reverse()` with antimeridian stitching. `hexBinMerge` builds a single mesh. Source: `node_modules/three-globe/dist/three-globe.mjs` lines 1194 (default res 4), 1249–1257, 1265–1325.
- **`polygonsData`** draws arbitrary cells and resolutions. Build `{geometry:{type:"Polygon",coordinates:[cellToBoundary(cell,true)]}}` for each cell. `cellToBoundary(c, true)` returns `[lng,lat]` pairs as a closed ring (7 points for a hexagon, verified). You must handle winding (three-globe's own hexbin reverses the ring) and antimeridian crossing yourself. Each polygon is a separate mesh, so this is slower than the merged hexbin.
- **`hexPolygonsData`** is the wrong tool: it tiles country-style polygons with hexes.

H3 average cell size (computed with h3-js 4.5.0 `getHexagonAreaAvg` / `getHexagonEdgeLengthAvg`):

| res | area km² | edge km | use |
|---|---|---|---|
| 3 | 12,393 | 69.0 | world view, sparse layers |
| 4 | 1,770 | 26.1 | **default world view** |
| 5 | 252.9 | 9.85 | continent / zoomed |
| 6 | 36.1 | 3.73 | region |
| 7 | 5.16 | 1.41 | Earth index storage (spec 3.4) |
| 8 | 0.737 | 0.531 | |
| 9 | 0.105 | 0.201 | |

**Component (verified: `next build` + `tsc` pass; rendered in a browser at `/dashboard` and at `/perf` with 3,752 res-4 cells in 4 colours).** Files go under `src/components/`.

```tsx
// src/components/EarthGlobe.tsx
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import { cellToLatLng, cellToParent, getResolution } from "h3-js";

export type LayerKey = "disasters" | "forest" | "mining" | "inbound";
export type CellRow = { cell: string; layer: LayerKey; value?: number };
export type Marker = { lat: number; lng: number; label: string; layer: LayerKey };

const LAYER_COLOR: Record<LayerKey, string> = {
  disasters: "#ff5a36", forest: "#2ee59d", mining: "#ffc233", inbound: "#4cc9ff",
};
const DISPLAY_RES = 4; // ~1,770 km² hexes: visible from orbit
type HexPoint = { lat: number; lng: number; layer: LayerKey; weight: number };

export default function EarthGlobe({ cells, markers }: { cells: CellRow[]; markers: Marker[] }) {
  const ref = useRef<GlobeMethods | undefined>(undefined);
  const [size, setSize] = useState({ w: 800, h: 600 });
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    onResize(); window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  useEffect(() => {
    const g = ref.current; if (!g) return;
    g.controls().autoRotate = true; g.controls().autoRotateSpeed = 0.35;
    g.pointOfView({ lat: 20, lng: -40, altitude: 2.2 }, 0);
  }, []);
  // one point per cell at its (parent) centre; hexbin re-derives the same H3 cell at DISPLAY_RES
  const hexPoints = useMemo<HexPoint[]>(() => cells.map((c) => {
    const p = getResolution(c.cell) > DISPLAY_RES ? cellToParent(c.cell, DISPLAY_RES) : c.cell;
    const [lat, lng] = cellToLatLng(p);
    return { lat, lng, layer: c.layer, weight: c.value ?? 1 };
  }), [cells]);

  return (
    <Globe
      ref={ref} width={size.w} height={size.h}
      backgroundColor="rgba(0,0,0,0)"
      globeImageUrl="/globe/earth-night.jpg" bumpImageUrl="/globe/earth-topology.png"
      showAtmosphere atmosphereColor="#3a7bff" atmosphereAltitude={0.18}
      hexBinPointsData={hexPoints} hexBinPointLat="lat" hexBinPointLng="lng" hexBinPointWeight="weight"
      hexBinResolution={DISPLAY_RES} hexMargin={0.15} hexAltitude={0.004}
      hexTopColor={(h) => LAYER_COLOR[(h.points[0] as HexPoint).layer]}
      hexSideColor={(h) => LAYER_COLOR[(h.points[0] as HexPoint).layer]}
      hexBinMerge={true} hexTransitionDuration={0}
      pointsData={markers} pointLat="lat" pointLng="lng"
      pointColor={(m) => LAYER_COLOR[(m as Marker).layer]}
      pointAltitude={0.02} pointRadius={0.25} pointLabel={(m) => (m as Marker).label}
    />
  );
}
```
```tsx
// src/components/EarthGlobeClient.tsx  — import THIS from server pages
"use client";
import dynamic from "next/dynamic";
export default dynamic(() => import("./EarthGlobe"), { ssr: false, loading: () => <div>Loading globe…</div> });
```
```tsx
// src/app/dashboard/page.tsx (Server Component) — fetch cells from Neon here and pass down as props
import EarthGlobe from "@/components/EarthGlobeClient";
export default async function Dashboard() { /* const cells = await sql`…` */ return <EarthGlobe cells={[]} markers={[]} />; }
```
Two caveats:

- When several stored cells share one display parent, they merge into one hex. Its colour comes from `points[0]`. Sort by priority, or compute the dominant layer in `hexTopColor`.
- `hexAltitude` defaults to `sumWeight*0.01`. Set it explicitly, as above, to keep the hexes flat.

Alternative, deck.gl. Type-checks against 9.4.1, but was **not rendered**:
```tsx
"use client";
import DeckGL from "@deck.gl/react";
import { _GlobeView as GlobeView } from "@deck.gl/core";          // core/dist/index.d.ts line 32 (experimental export)
import { H3HexagonLayer } from "@deck.gl/geo-layers";             // getHexagon: (d) => string (H3 id); extruded default true
import { ScatterplotLayer } from "@deck.gl/layers";
// <DeckGL views={new GlobeView({resolution:10})} initialViewState={{longitude:-40,latitude:20,zoom:0.8}} controller
//   layers={[new H3HexagonLayer({id:"cells",data,getHexagon:d=>d.hex,getFillColor:d=>d.rgb,extruded:false}), ...]} />
```
Source: `@deck.gl/core/dist/views/globe-view.d.ts` (`GlobeViewState {longitude, latitude, zoom}`, `GlobeViewProps {resolution, altitude,…}`); `@deck.gl/geo-layers/dist/h3-layers/h3-hexagon-layer.d.ts`. You'd need a separate basemap or land layer, and there's no atmosphere.

### 3.4 Hosting the Terragent MCP server (mcp-handler v2)

Exact signatures (`node_modules/mcp-handler/dist/index.d.ts`, v2.3.1):

```ts
// line 103 (exported as createMcpHandler)
createMcpHandler(
  initializeServer: (server: McpServer) => void | Promise<void>,
  options?: ServerOptions & {
    serverInfo?: { name: string; version: string };
    verboseLogs?: boolean;
    onEvent?: (e: McpEvent) => void;          // McpEvent.type: "REQUEST_RECEIVED" | "REQUEST_COMPLETED" | "ERROR"
    maxSubscriptions?: number;                // default 1024
    experimental_webMcp?: { tools: string[]; credentials?: "same-origin"|"include"|"omit"; cacheControl?: string };
  },
): (request: Request) => Promise<Response>
// line 285
withMcpAuth(
  handler: (req: Request) => Response | Promise<Response>,
  verifyToken: (req: Request, bearerToken?: string) => AuthInfo | undefined | Promise<AuthInfo | undefined>,
  opts?: { required?: boolean; resourceMetadataPath?: string; requiredScopes?: string[]; resourceUrl?: string },
): (req: Request) => Promise<Response>
// line 319
protectedResourceHandler({ authServerUrls: string[]; resourceUrl?: string }): (req: Request) => Response
metadataCorsOptionsRequestHandler(): () => Response
```
`McpServer.registerTool` (`@modelcontextprotocol/server/dist/mcp-BCJHyo7l.d.mts` line 3373):
```ts
registerTool(name: string, config: {
  title?: string; description?: string;
  inputSchema?: StandardSchemaWithJSON;  outputSchema?: StandardSchemaWithJSON;   // pass z.object({...}) (raw shape is @deprecated)
  annotations?: ToolAnnotations; icons?: Icon[]; scopeChallenge?: ScopeChallengeHandler; _meta?: Record<string, unknown>;
}, cb: (args, ctx: ServerContext) => CallToolResult | InputRequiredResult | Promise<…>): RegisteredTool
```
`AuthInfo` (line 774): `{ token: string; clientId: string; scopes: string[]; expiresAt?: number; resource?: URL; resourceMetadataUrl?: string; extra?: Record<string, unknown> }`. The tool callback reads it at `ctx.http?.authInfo` (line 2213). The original request is `ctx.http?.req`.

The route below is verified: it builds under Next 16.4.5, and the live calls further down went through `next start`.

```ts
// src/app/api/mcp/route.ts
import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "earth_index_lookup",
      {
        title: "Earth index lookup",
        description: "Derived results stored for an H3 cell.",
        inputSchema: z.object({ cell: z.string(), metric: z.string().optional() }),
      },
      async ({ cell, metric }, ctx) => {
        const caller = ctx.http?.authInfo?.clientId ?? "unknown";
        return { content: [{ type: "text", text: JSON.stringify({ cell, metric, caller, rows: [] }) }] };
      },
    );
  },
  { serverInfo: { name: "terragent", version: "0.1.0" } },
);

const verifyToken = async (_req: Request, bearerToken?: string): Promise<AuthInfo | undefined> => {
  if (!bearerToken || bearerToken !== process.env.TERRAGENT_MCP_TOKEN) return undefined; // use timingSafeEqual in prod
  return { token: bearerToken, clientId: "naive-agents", scopes: [] };
};

const authHandler = withMcpAuth(handler, verifyToken, { required: true });
export { authHandler as GET, authHandler as POST };
```
Live calls against the route above, run with `next start`:
```
POST /api/mcp (no Authorization)                    -> 401
  www-authenticate: Bearer error="invalid_token", error_description="No authorization provided",
                    resource_metadata="http://localhost:3917/.well-known/oauth-protected-resource"
POST /api/mcp  Authorization: Bearer <token>  mcp-protocol-version: 2025-06-18
  {"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"earth_index_lookup","arguments":{"cell":"8828308281fffff"}}}
  -> 200 content-type: text/event-stream
     event: message
     data: {"result":{"content":[{"type":"text","text":"{\"cell\":\"8828308281fffff\",\"caller\":\"naive-agents\",\"rows\":[]}"}]},"jsonrpc":"2.0","id":2}
initialize with protocolVersion "2025-03-26" or "2025-06-18"                        -> 200, echoes the version
POST with only "Accept: application/json"                                           -> 406 "Client must accept both application/json and text/event-stream"
GET  /api/mcp                                                                       -> 405 "Method not allowed." (stateless)
POST "server/discover" with mcp-protocol-version 2026-07-28 but no params._meta     -> 400 (2026 era needs a per-request _meta envelope)
```
Protocol support (README): it serves the **2026-07-28** spec natively (stateless, `server/discover`) and falls back to stateless 2025-era Streamable HTTP. The HTTP+SSE transport and Redis were removed in 2.x. `basePath`, `maxDuration` and `redisUrl` options are gone: mount the handler on whatever route you like. The core package's `LATEST_PROTOCOL_VERSION` constant is `"2025-11-25"` (`@modelcontextprotocol/core/dist/internal.d.mts` line 5).

Client config for any Streamable-HTTP client, including the Naïve MCP connector: `{ "url": "https://<prod-domain>/api/mcp", "headers": { "Authorization": "Bearer <TERRAGENT_MCP_TOKEN>" } }`. **(critic-verified, Naïve capabilities/tools.md "MCP connector") Not for Naïve.** Naïve rejects inline `Authorization`, cookie and API-key headers on `mcp_servers` ("Secret-bearing inline headers … are rejected").
- For Naïve, declare `mcp_servers: [{ name: "terragent", url: "https://<prod-domain>/api/mcp" }]`.
- Store the token as a vault `static_bearer` whose `mcp_server_url` is that exact string. Naïve injects it server-side, presumably as `Authorization: Bearer`, which `withMcpAuth` reads; the header format is unverified.
- Name tools without dots (`earth_index_lookup`). Naïve keys them `terragent.earth_index_lookup` in `tools.configs`, and each one must be set to `allow` explicitly (MCP tools default to `ask`). The README also documents `npx -y mcp-remote <url>` for stdio-only clients, and Vercel's guide uses `npx @modelcontextprotocol/inspector@latest` for testing.
Source: `node_modules/mcp-handler/README.md`; https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel.md (its auth example is the same `withMcpAuth` pattern with `MCP_DEMO_TOKEN`).

### 3.5 Rate-limited `POST /answer` (no extra services)

The `api_keys` and `rate_limits` tables already exist in `db/migrations/001_init.sql` (lines 351–366). The fixed-window counter is one atomic statement, so concurrent calls can't race. It was verified on PGlite with the repo migration: sequential counts went 1, 2, 3, 4, and 20 concurrent calls ended at count 20.

```sql
INSERT INTO rate_limits (bucket, window_start, count)
VALUES ($1, date_trunc('hour', now()), 1)
ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
RETURNING count, window_start + interval '1 hour' AS resets_at;
```
```ts
// src/app/api/answer/route.ts  (compiles on Next 16.4.5; DB calls not run against real Neon)
import { neon } from "@neondatabase/serverless";   // neon(connectionString) -> tagged template, 1 HTTP round trip per query
import { createHash } from "node:crypto";
export const maxDuration = 300;
const sql = neon(process.env.DATABASE_URL!);

export async function POST(req: Request) {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? req.headers.get("x-api-key");
  if (!key) return Response.json({ error: "missing_api_key" }, { status: 401 });
  const keyHash = createHash("sha256").update(key).digest("hex");
  const k = (await sql`SELECT id, rate_per_hour FROM api_keys WHERE key_hash = ${keyHash} AND NOT revoked`)[0] as
    { id: string; rate_per_hour: number } | undefined;
  if (!k) return Response.json({ error: "invalid_api_key" }, { status: 401 });
  const [{ count, resets_at }] = (await sql`
    INSERT INTO rate_limits (bucket, window_start, count) VALUES (${"key:" + k.id}, date_trunc('hour', now()), 1)
    ON CONFLICT (bucket, window_start) DO UPDATE SET count = rate_limits.count + 1
    RETURNING count, window_start + interval '1 hour' AS resets_at`) as { count: number; resets_at: string }[];
  const reset = String(Math.ceil((new Date(resets_at).getTime() - Date.now()) / 1000));
  const h = { "RateLimit-Limit": String(k.rate_per_hour), "RateLimit-Remaining": String(Math.max(0, k.rate_per_hour - count)), "RateLimit-Reset": reset };
  if (count > k.rate_per_hour) return Response.json({ error: "rate_limited" }, { status: 429, headers: { ...h, "Retry-After": reset } });
  // validate body, create request row, kick off Naïve session, then:
  return Response.json({ status: "accepted" /*, request_id */ }, { status: 202, headers: h });
}
```
Add a second bucket, `ip:${req.headers.get("x-forwarded-for")?.split(",")[0]}`, for unauthenticated portal form posts. Prune old windows with `DELETE FROM rate_limits WHERE window_start < now() - interval '1 day'`, either inside `after()` or from a Naïve cron.
Source: `@neondatabase/serverless/index.d.ts` line 595 (`neon(...)`) and line 857 (tagged-template call signature).

### 3.6 Stripe Payment Links

- **Sharing:** a human creates the link in the Dashboard and copies its URL (`https://buy.stripe.com/...`), or makes a QR code or buy button. Links can't be deleted, only deactivated. Source: https://docs.stripe.com/payment-links/share.md
- **Per-request URL parameters:**
  - `?client_reference_id=req_abc123`: alphanumerics, `-` and `_`, up to 200 characters. Invalid values are silently dropped. It comes back in the `checkout.session.completed` webhook. Our `req_…` ids fit. Source: https://docs.stripe.com/payment-links/url-parameters.md
  - `prefilled_email` and `locked_prefilled_email`. Source: https://docs.stripe.com/payment-links/customize.md
- **Without a server:** Stripe can email the account holder on each successful payment if they enable it in Personal details settings. A human then marks the request paid, which counts as an intervention. Confirmation can also redirect to our URL with `{CHECKOUT_SESSION_ID}`. Source: https://docs.stripe.com/payment-links/post-payment.md
- **Automated (needs a server or a key):**
  - Webhook route on our Vercel app: verify with `stripe.webhooks.constructEvent(rawBody: string, sigHeader, whsec)` and read the raw body with `await req.text()`. Source: `stripe/esm/Webhooks.d.ts` lines 47/53. Event types: `checkout.session.completed`, plus `checkout.session.async_payment_succeeded` / `checkout.session.async_payment_failed` for delayed methods (`stripe/esm/resources/Events.d.ts`).
  - Or poll `GET https://api.stripe.com/v1/checkout/sessions?payment_link=plink_…&status=complete` (status enum `complete|expired|open`). Source: https://docs.stripe.com/api/checkout/sessions/list.md

### 3.7 Paid imagery providers

#### SkyWatch (EarthCache / Explore / Hub)

- **Public price list**, which SkyWatch calls starting rates, in USD. Source: https://skywatch.com/data (redirects to /data-pricing/), fetched 2026-11-07.

  | Product tier | Resolution | Archive from | Tasking from | Min order from |
  |---|---|---|---|---|
  | HD Optical | 15 cm | $25.00/km² | $30.00/km² | 1 km² archive, 1 km² tasking |
  | Very High-Res Optical | 30–49 cm | $19.00 | $29.00 | 1 km², 1 km² |
  | High-Res Optical | 50–99 cm | $10.00 | $12.00 | 1 km², 25 km² |
  | Medium-Res Optical | 1–8 m | $2.50 | $3.50 | 1 km², 25 km² |
  | Elevation DEM/DTM/DSM | 0.5–4 m | $8.75 | request pricing | 10 km² |
  | Aerial | >10 cm / <10 cm | $50 / $67 | — | 0.1 km² |
  | Drone (Spexi) | 2.8 cm | — | $45 per 0.1 km² | 0.5 km² |

  The page says "No quote needed", "Pay as you go" and "Order from as little as 0.1 km²".

- **Per-product live rates.** I called the **public MCP server** `get_offerings` at `https://mcp.skywatch.com/mcp`, unauthenticated, 2026-11-07. It returned 33 products. Excerpt:

  | Product | Provider | GSD | Archive $/km² | Tasking $/km² | Min order |
  |---|---|---|---|---|---|
  | Vantor-15cm | Vantor | 15 cm | 25.00 | 35.00 | 1 km² |
  | Vantor-30cm | Vantor | 30 cm | 19.00 | 29.00 | 1 km² |
  | Vantor-50cm | Vantor | 50 cm | 14.00 | 25.00 | 1 km² |
  | Vivid-Mosaic-30cm (basemap) | Vantor | 30 cm | 12.00 | — | 1 km² |
  | Pleiades-Neo | Airbus | 30 cm | 22.50 | 32.50 | 5 km² |
  | Pleiades-Neo-HD15 | Airbus | 15 cm | 25.00 | 35.00 | 25 km² |
  | SkySat | Planet | 50 cm | 10.00 | 12.00 | 25 km² |
  | Kompsat-3A | SIIS | 40 cm | 10.00 | 12.00 | 25 km² |
  | SuperView-Neo | Siwei | 30 cm | 19.00 | 29.00 | 25 km² |
  | EROS-C | ImageSat | 30 cm | 20.00 | 48.00 | 25 km² |
  | Umbra-Spotlight-25cm (SAR) | Umbra | 25 cm | — | 190.00 | 25 km² |
  | TerraSARX-Staring-Spotlight (SAR) | Airbus | 25 cm | 206.93 | 413.85 | 14.8 km² |
  | Eagleview-Custom (aerial) | Eagleview | 20 cm | 31.00 | — | 0.1 km² |
  | Spexi-Ortho (drone) | Spexi | 3 cm | — | 450.00 | 0.5 km² |

  The live `calculate_pricing` call for a 1 km² AOI in Houston, `{"coordinates":{"lat":29.7604,"lon":-95.3698,"radius_km":1},"resolution":"very_high","tasking":false}`, returned 25 archive products. The range was **$12.00 (Vivid-Mosaic-30cm) to $3,062.56 (TerraSAR-X)**. Each total already applies the minimum-order rule: Pleiades-Neo comes to $112.50 because of its 5 km² minimum.

- **Minimum billable AOI** differs from minimum AOI size. Examples: Pléiades-Neo 30 cm archive has a 1 km² minimum AOI but 5 km² billable, and HD15 has 25 km² billable. Vendor geometry rules: Airbus tasking needs a ≥2 km corridor and ≤13 km width, Vantor ≥2 km width, Planet ≥1 km width. AOIs must be a single polygon with 4–500 vertices, no holes, file ≤13 kB. Source: https://intercom.help/skywatch-ab92e82e1a0a/en/articles/9917241-aoi-size-and-cost-requirements-hub

- **Public MCP server.** `POST https://mcp.skywatch.com/mcp`; initialize answers `protocolVersion "2025-03-26"`, `serverInfo {name:"skywatch-mcp-server", version:"1.0.0"}`.
  - Tools available without sign-in (live `tools/list`):
    - `search_archive_imagery {location_query|coordinates{lat,lon,radius_km}|bbox|geojson, …}`
    - `calculate_pricing {location_query|coordinates|bbox, start_date, end_date, resolution: very_high|high|medium|low, tasking: boolean, interval, source?}`
    - `get_satellites {filter_by_resolution, filter_by_type: optical|sar|elevation|all}`
    - `get_offerings {category: archive|tasking|all, partner_filter, product_name, limit≤100}`
    - `get_started`
  - Signing in with OAuth and a SkyWatch account unlocks 24 tools, including `place_order` and `place_tasking_order`. Hub accounts get 51.
  - Source: https://docs.skywatch.com/docs/mcp/setup-guide

- **REST API (EarthCache v1.7):**
  - Base URL: `https://api.skywatch.co/earthcache`. Auth header: `x-api-key: <key>` (no Bearer).
  - Endpoints:
    - `POST /archive/search`: `{location: Polygon, start_date, end_date, resolution: low|medium|high|very_high, coverage, order_by: resolution|cost|coverage|date (prefix - for desc), off_nadir_angle:[min,max]}`, then `GET /archive/search/{id}/search_results`
    - `POST /price/calculate`: `{resolution (req), location (req), start_date, end_date, interval:"Nd", tasking:boolean, source}`
    - `POST /pipelines`: creates an order. Fields: `budget_per_km2` or `max_cost`, `cloud_cover_percentage`, `min_aoi_coverage_percentage`, `resolution_low/high` (0.3–30 m), `interval`, `result_delivery.priorities: lowest_cost|highest_resolution|earliest|midpoint|latest`.
    - `POST /subscriptions`: webhooks.
  - Constraints: archive minimum >1 km²; tasking interval ≥7 days and placed ≥2 days before start; no cancel within 48 h; archive orders are non-refundable.
  - Source: https://docs.skywatch.com/llms.txt and https://docs.skywatch.com/openapi-spec.json (fetched; 47 operations)

- **Delivery and payment:** Explore puts a card hold for the order total, captured on delivery and released if nothing is delivered after 7 days. "Archive orders cannot be cancelled or refunded." Source: https://intercom.help/skywatch-ab92e82e1a0a/en/articles/9952716-explore-faq

- **Licence:** "Restrictions do apply to all imagery acquired through SkyWatch. Please contact our support team to determine if you are able to use your image for publishing." (same FAQ). The terms article (`.../9151498-skywatch-terms-and-conditions`) returned 401. Third-party licences are viewable inside the Explore app after login.

- **Quotes and contact:** use the "Talk to Sales" HubSpot form at https://skywatch.com/contact-sales/ (reply "within one business day"), or email support@skywatch.com (from llms.txt). Prices are self-serve, so most jobs need no quote. Elevation tasking is "request pricing".

#### UP42

- Credits are the currency: **100 credits = €1**. The minimum purchase is 10,000 credits (€100). Credits expire after 24 months and are non-refundable. The first purchase triggers a compliance check (usually fast; "if it's been over 24 hours … reach out"). Source: https://docs.up42.com/getting-started/purchase.md; https://up42.com/pricing

- **Headline "from" prices** (https://up42.com/pricing):

  | Category | Archive from | Tasking from |
  |---|---|---|
  | Optical VHR | €6.80/km² | €12.00/km² |
  | Optical high/medium | €1.00/km² | €2.20/km² |
  | SAR | €286/scene (10,000 km²) | €875/scene |
  | Elevation | €2.00/km² | €32.14/km² |
  | Aerial | €5.00/km² | €47.00/km² |
  | Hyperspectral | €7.00/km² | €8.00/km² |
  | Thermal | €1.60/km² | €6.40/km² |
  | Sentinel-2 / Landsat | free | — |

- **Per-collection "from" prices.** These come from the "Collection type" row of each collection's doc, `https://docs.up42.com/data/<slug>.md`. Euro values are credits ÷ 100.

  | Collection | Catalog (archive) from | Tasking from | Catalog min chargeable | Tasking min chargeable |
  |---|---|---|---|---|
  | pleiades-neo (30 cm) | 1,800 cr/km² = €18.00 | 2,600 = €26.00 | 0.1 km² (10-min delivery subset), 5 km² (few days), 25 km² HD15 | 100 km² |
  | pleiades (50 cm) | €10.00 | €17.00 | 0.1 / 1 / 25 km² | 100 km² |
  | spot (1.5 m) | €2.00 | €2.80 | 0.1 / 1 / 25 km² | 100 km² |
  | vantor | €13.50 | €22.50 | 1 km² (VNIR) | 25 km² (VNIR) |
  | beijing-3n (30 cm) | €16.00 | €23.00 | 15 km² | 70 km² |
  | kompsat-3a | €6.80 | €15.20 | 10 km² | 50 km² |
  | eros-c | €17.00 | €51.00 | none (tech limits) | 100 km² |
  | planet | €6.00/km² | €290/scene | 25 km² | 1 scene |
  | satellogic | €5.00/km² | €300/scene | 50 km² | 1 scene |
  | blacksky | €90/scene | €175/scene | 1 scene | 1 scene |
  | capella-space (SAR) | €290/scene | €845/scene | 1 scene | 1 scene |
  | iceye (SAR) | €285.71/scene | €700/scene | 1 scene | 1 scene |
  | umbra (SAR) | — | €673/scene | — | 1 scene |
  | hydrosat (thermal) | €1.60 | €6.40 | 500 km² | 500 km² |
  | dragonette-1 (hyperspectral) | €490/scene | €8.00/km² | 400 km² | 100 km² |

  Minimums source: https://docs.up42.com/data/catalog-min-charges.md and https://docs.up42.com/data/tasking-min-charges.md

- **Delivery:** some Pléiades Neo catalog scenes arrive in "10 minutes", the rest in "a few days". The Pléiades Neo tasking minimum acquisition window is at least 30 or 60 days depending on the option. Collections flagged `ACCESS_APPROVAL_REQUIRED` take "up to 3 working days" to review. Source: https://docs.up42.com/data/pleiades-neo.md lines 339–362; https://docs.up42.com/developers/api-catalog.md line 45.

- **API:**
  - Base URL: `https://api.up42.com`. `GET /v2/collections` is **public**: it returned 71 collections live, each with `name`, `type: ARCHIVE|TASKING`, `integrations[]` (values seen: `SEARCH_AVAILABLE`, `PRICE_ESTIMATION_AVAILABLE`, `QUOTATION_REQUIRED`, `ACCESS_APPROVAL_REQUIRED`, `FEASIBILITY_STUDY_REQUIRED`, `FEASIBILITY_STUDY_MAY_BE_REQUIRED`, `TASKING_OPPORTUNITIES_AVAILABLE`, `SAMPLE_DATA_AVAILABLE`, `THUMBNAIL_AVAILABLE`, `QUICKLOOK_AVAILABLE`), `metadata.productType`, `resolutionClass`, `providers[]` and `dataProducts[{id,name,title,eulaId}]`.
  - `POST /v2/orders/estimate` **requires auth**: an unauthenticated call returned 401 live. The response is `{summary:{totalCredits, totalSize, unit:"SQ_KM"}, results:[{index, credits, size, unit}]}`.
  - Auth: `POST https://auth.up42.com/realms/public/protocol/openid-connect/token` with form fields `username=<email>&password=<pw>&grant_type=password&client_id=up42-api`. The token lasts 300 s (`expires_in`) and the refresh token 1800 s.
  - Source: https://docs.up42.com/developers/authentication.md; https://docs.up42.com/developers/api-catalog.md lines 248–275

- **Licence** (https://docs.up42.com/getting-started/eulas.md):
  - Data is "licensed, not sold": non-transferable, non-sublicensable, non-exclusive, revocable.
  - **"Can I resell the data I ordered? No, but you can use the original data product for your own internal business purposes."**
  - "Can my client access the data I ordered? No, your client must order the data themselves."
  - Value-added products (some original data remains): "Most licensors don't allow external use and redistribution."
  - Derivative products (no original data remains): "The licensee can usually freely use and distribute", sometimes with notification, attribution or a price uplift for more than one customer.
  - Media use needs a separate media licence.

- **Quotes:** tasking collections flagged `QUOTATION_REQUIRED` are quoted in the console. Sales uses a web form at https://up42.com/contact-us/sales. I found no public sales email.

#### Arlula

- **Status:** arlula.com now sells "Geostack", an EO infrastructure for operators and enterprises. https://arlula.com/pricing **redirects to /geostack/overview**, and there is **no public price list**. Contact: **hello@arlula.com** (mailto on arlula.com). Source: live fetch, 2026-11-07.
- **API** (https://docs.arlula.com/apis):
  - Base URL: `https://api.arlula.com`. Auth: HTTP Basic with an API Key and API Secret created in the dashboard (https://dashboard.arlula.com, which redirects to `/login`). `GET /api/test` checks auth.
  - Archive endpoints (STAC-based since 2026-08):
    - `GET|POST /api/archive/search`: `{bbox|intersects, collections, datetime:"a/b", filter (CQL2 subset on properties.eo:cloud_cover, properties.view:off_nadir, properties.gsd, …), ids, limit}`
    - `GET /api/archive/quote`: `{items:[{id, license, orderLevel}]}`, returns `pricing {license, orderLevel, total}`
    - `POST /api/archive/order`: `{items:[{id, level, license}], payment, team, emails, webhooks, coupon}`
  - Price fields on each search result: `price:currency`, `price:unit_price`, `price:units` ("sqkm"), `price:order_levels[{key,name,price}]` and `price:license_options[{href,key,name,loadingAmount,loadingPercent}]`. A licence choice adds a loading on top of the price.
  - Source: https://docs.arlula.com/apis/archive
  - Note: live responses carry the header `api-version: 2023-08`, while the docs changelog lists versions up to 2026-10.

#### Planet (direct)

From the https://www.planet.com/pricing/ page data, fetched 2026-11-07:

- **SkySat Archive $6/km²** (imagery 30 days and older), **SkySat Flexible Tasking $12/km²**, **SkySat Assured Tasking $40/km²**. The "minimum order size or area of interest is 25 square kilometers when using Planet Select".
- PlanetScope comes through the Insights Platform subscription: Starter $110/month (7,000 monitoring credits), Professional $550/month (40,000), Scale $1,200/month (100,000). The minimum PlanetScope order on Insights Flex is 1 km².
- "Planet does not offer the option to purchase individual images over small areas without a contract."
- Contact: https://www.planet.com/contact-sales

#### Vantor (formerly Maxar) and Airbus OneAtlas (direct)

No public direct price list was found. Use the reseller rates above: SkyWatch (Vantor 15/30/50 cm; Pléiades Neo) and UP42 (vantor; pleiades-neo). Airbus licence terms are at https://space-solutions.airbus.com/legal/licences/ (linked from UP42's EULA page; not fetched).

#### Seed rows for the `providers` registry

Columns as in `001_init.sql`. USD from SkyWatch, EUR from UP42; record the currency in `citations[].note`, since the table has no currency column.

| id | vendor | data_type | resolution_m | archive / km² | tasking / km² | min_order_km2 | access_method | quote_contact |
|---|---|---|---|---|---|---|---|---|
| pc-sentinel-2-l2a | Microsoft PC | optical | 10 | 0 (free) | — | — | stac | — |
| sw-vantor-30cm | SkyWatch (Vantor) | optical | 0.30 | $19.00 | $29.00 | 1 (tasking 25) | api (public MCP pricing) | https://skywatch.com/contact-sales/ |
| sw-vantor-50cm | SkyWatch (Vantor) | optical | 0.50 | $14.00 | $25.00 | 1 (tasking 25) | api | same |
| sw-pneo-30cm | SkyWatch (Airbus) | optical | 0.30 | $22.50 | $32.50 | 5 billable | api | same |
| sw-skysat-50cm | SkyWatch (Planet) | optical | 0.50 | $10.00 | $12.00 | 25 | api | same |
| sw-medium-optical | SkyWatch | optical | 1–8 | $2.50 | $3.50 | 1 (tasking 25) | api | same |
| sw-umbra-25cm | SkyWatch (Umbra) | radar | 0.25 | — | $190.00 | 25 | api | same |
| up42-pleiades-neo | UP42 (Airbus) | optical | 0.30 | €18.00 | €26.00 | 0.1/5 (tasking 100) | api (estimate needs auth) | https://up42.com/contact-us/sales |
| up42-spot | UP42 (Airbus) | optical | 1.5 | €2.00 | €2.80 | 0.1/1 (tasking 100) | api | same |
| up42-vantor | UP42 (Vantor) | optical | 0.30–0.50 | €13.50 | €22.50 | 1 (tasking 25) | api | same |
| up42-hydrosat | UP42 (Hydrosat) | thermal | 70 (thermal), 30 (MS) | €1.60 | €6.40 | 500 | api | same |
| up42-dragonette-1 | UP42 (Dragonette-1) | hyperspectral | 5.3 | €490/scene | €8.00 | 400 (tasking 100) | api | same |
| planet-skysat | Planet | optical | 0.50 | $6.00 | $12.00 flexible / $40.00 assured | 25 | api (contract) | https://www.planet.com/contact-sales |
| arlula-archive | Arlula | optical (multi) | varies | per-scene via API | via API | via API | api / email_quote | hello@arlula.com |

---

## 4. Discrepancies with the master prompt

| Spec says | Reality | Impact |
|---|---|---|
| §5.2: compare SkyWatch, UP42, Arlula "on public price lists" | SkyWatch: public list **plus** a public, no-login MCP server that returns live per-product $/km² and minimums. UP42: per-collection "from" prices in docs, exact estimate needs auth. Arlula: **no public prices; the company pivoted to Geostack** | Give the Orchestrator the SkyWatch MCP (no key, no spend) as its pricing source. Treat UP42 as a docs price table and Arlula as an email quote target (hello@arlula.com) |
| §5.2 / §9: deliver derived results, never raw imagery | UP42 EULA guidance: value-added products (anything that still contains original pixels, e.g. before/after crops) usually **cannot** go to customers. Only derivative products (no original data) usually can. Resale: "No". "Your client must order the data themselves." | Paid-imagery reports must not embed the purchased image. Show derived rasters, vectors and measurements, or have the customer be the licensee. Free Sentinel-2/Landsat images in reports are fine |
| §7: "Vercel's free subdomain is fine" | Hobby is "non-commercial personal use only"; commercial use includes "requesting or processing payment from visitors of the site" | Keep the Stripe link in emails rather than on site pages, or use a Pro trial. Founders decide (ToS risk) |
| §7: webhooks keep the DB current (implicitly on Vercel) | Standard Deployment Protection blocks per-deployment and preview URLs; only production domains are public | Register Naïve, AgentMail and Stripe webhooks against the **production** domain (`<project>.vercel.app`), never a deployment URL |
| (implicit) cron could live in Vercel | Hobby Cron Jobs run once a day max (Schedules beta: every 15 min) | Keep all cron in Naïve deployments, as the spec already says |
| §3.4: H3 res 7–9 rendered on the globe | Res 7 cells average 5.2 km²; invisible at globe scale | Store at res 7–9; render parents at res 4 (world) and 5–6 (zoomed) with `cellToParent` |
| §5.2: "Maxar" (implied in the brief) | Rebranded **Vantor** in SkyWatch and UP42 catalogues | Use "Vantor" in the registry |
| §6: payment link set up by a human | Correct. Detecting payment without human action needs a webhook route or polling with a Stripe key | Without automation, each "paid" mark is a human intervention (§11 goal: fewer than 10) |
| MCP hosting (§7 stack) | The current Vercel adapter is mcp-handler **v2** on `@modelcontextprotocol/server` v2 (not `@modelcontextprotocol/sdk`), stateless, no SSE, 2026-07-28 spec plus 2025 fallback | Don't copy older v1 tutorials: no `server.tool()`, no `redisUrl` or `basePath`; use `inputSchema: z.object()` |

---

## 5. Answers to open questions (spec §14)

| Question | Answer | Confidence | Source |
|---|---|---|---|
| What do paid imagery providers charge? | **VHR optical archive:** about $10–25/km² (SkyWatch: Vantor 30 cm $19, Pléiades Neo 30 cm $22.50 with 5 km² billable minimum, SkySat 50 cm $10 with 25 km² minimum); about €6.80–18/km² on UP42; Planet SkySat direct $6/km² (25 km² minimum). **VHR tasking:** about $12–35/km² (SkyWatch), €12–26/km² (UP42) with 25–100 km² minimums. **Medium-res (1–8 m) archive:** from $2.50/km². **SAR:** about $190–414/km² (SkyWatch) or €285–845 per scene (UP42). A typical 1 km² property check costs **$12–25** on SkyWatch archive (live quote, Houston). Any Pléiades Neo or SkySat order pays its 5–25 km² minimum | high (SkyWatch live, UP42 docs, Planet page); low (Arlula, Airbus/Vantor direct) | §3.7 URLs |
| On what licence terms? | UP42: licensed not sold; no resale; customers can't access our orders; derivative products usually shareable; media licence separate. SkyWatch: "restrictions do apply to all imagery"; per-provider third-party licences (behind login). Arlula: licence is a priced option per scene (`price:license_options`, with loadings) | high (UP42), medium (SkyWatch), medium (Arlula API shape) | https://docs.up42.com/getting-started/eulas.md; SkyWatch Explore FAQ; https://docs.arlula.com/apis/archive |

The other §14 questions (Naïve models, email wake-up, Neon extensions, sponsors, judging) are outside this topic.

---

## 6. Credentials needed

| Env var | Service | Where to get it | Cost | Needed for |
|---|---|---|---|---|
| `TERRAGENT_MCP_TOKEN` | our MCP server | generate yourself (`openssl rand -hex 32`); put in `.env`, Vercel env, and the Naïve vault for the MCP connector | free | `/api/mcp` bearer auth |
| `DATABASE_URL` | Neon (already H4) | Neon console, pooled connection string | credits | `/answer` keys and rate limits, globe data |
| (Vercel account, no env var) | Vercel (already H7) | vercel.com, Hobby, linked to GitHub `lapark714` | free (non-commercial ToS) | deploy |
| `PAYMENT_LINK_URL` | Stripe (already H9) | Stripe Dashboard → Payment Links → copy | free; Stripe fees per payment | quotes |
| `STRIPE_SECRET_KEY` (restricted, read Checkout Sessions) *or* `STRIPE_WEBHOOK_SECRET` (`whsec_…`) | Stripe | Dashboard → Developers → API keys / Webhooks (endpoint `https://<prod>/api/webhooks/stripe`, event `checkout.session.completed`) | free | optional: automatic paid detection |
| (none) | SkyWatch public MCP | `https://mcp.skywatch.com/mcp`, no account | free | live price comparisons |
| `SKYWATCH_API_KEY` | SkyWatch EarthCache REST (`x-api-key`) | free account at explore.skywatch.com → API key | free account; orders are paid by card | only to actually order (founder-approved) |
| `UP42_USERNAME` / `UP42_PASSWORD` | UP42 (password-grant token) | console.up42.com account; first credit purchase triggers a compliance check | free account; €100 minimum credit purchase to order | exact `/v2/orders/estimate`; ordering |
| `ARLULA_API_KEY` / `ARLULA_API_SECRET` | Arlula | dashboard.arlula.com → API account | unknown | archive search, quote, order |
| `PLANET_API_KEY` | Planet | Insights Platform account (subscription from $110/month) | paid | not recommended for the weekend |

---

## 7. Gotchas and limits

**MCP server**
- Clients that don't send `Accept: application/json, text/event-stream` get 406. Plain `curl` tests need that header.
- GET returns 405, because the server is stateless.
- Responses are SSE-framed (`event: message\ndata: {...}`) even for single results.
- The 401 challenge advertises `resource_metadata=<origin>/.well-known/oauth-protected-resource`, which we don't serve. OAuth-capable clients may try discovery and fail. Configure the Naïve connector with a static `Authorization` header. If a client insists on OAuth, add `protectedResourceHandler` (see §8). (critic) For Naïve that "static header" must be a vault `static_bearer` credential, not an inline header (see §3.4 note).
- Use `withMcpAuth(..., { resourceUrl })` behind proxies if the origin comes out wrong. mcp-handler reads `X-Forwarded-Host`/`-Proto`.

**Vercel**
- **300 s max on Hobby.** Return 202 and poll for the demo.
- **4.5 MB body cap.** Don't proxy report PDFs or imagery through functions: link to Naïve Files or Blob instead. Webhook payloads with attachments may exceed it.
- 1 hour of runtime logs on Hobby: log decisions to Neon, not just the console.
- Over-quota on Hobby pauses the feature for 30 days. Watch Active CPU (4 h/month). I/O wait doesn't count toward Active CPU.

**Globe**
- `ssr:false` only works inside a `"use client"` file. A static import of `react-globe.gl` anywhere that gets prerendered fails the build with `window is not defined` (reproduced).
- The default `hexBinResolution` is 4. Coarse cells merge layers; colour comes from `points[0]`.
- `hexAltitude` defaults to `sumWeight*0.01`, so weights make tall spikes. Set a constant.
- Images: `globeImageUrl` is fetched by the client, so serve it from `/public`.
- three-globe imports `three/webgpu` and `three/tsl`, so don't pin `three` below what globe.gl requires (>=0.179).

**H3**
- `cellToBoundary(c)` returns `[lat,lng]`; `cellToBoundary(c, true)` returns `[lng,lat]` as a closed ring. Mixing them up flips cells across the globe.

**Rate limiting**
- Fixed windows allow a burst of up to 2× the limit around the hour boundary. That's acceptable here.
- Every `/answer` costs two Neon HTTP queries before any work. Neon HTTP queries can't be transactions; the upsert is a single statement, so that's fine.

**Stripe**
- Webhook signature verification needs the raw body (`await req.text()`, not `req.json()`).
- Delayed payment methods need the `async_payment_*` events.
- `client_reference_id` silently drops invalid characters, so keep ids to `[A-Za-z0-9_-]`.

**Imagery providers**
- **SkyWatch:**
  - Archive orders are non-refundable and auto-charged on delivery.
  - Minimum *billable* area is often larger than minimum AOI (Pléiades Neo: 5 km²).
  - Tasking needs a ≥7-day window, placed ≥2 days ahead.
  - AOI must be a single polygon, 4–500 vertices, no holes, ≤13 kB.
  - Explore needs a credit card (no debit or prepaid).
- **UP42:**
  - EUR credits, €100 minimum top-up, non-refundable, 24-month expiry.
  - Compliance check on the first purchase.
  - Some collections need access approval (up to 3 working days) or a feasibility study.
  - The token lasts 5 minutes.
  - Tasking minimums are large (Pléiades/Pléiades Neo/SPOT: 100 km²).
- **Planet:** no small purchases without a contract or subscription.
- **Licences:** see §4. Don't put purchased pixels in customer reports.

---

## 8. Unverified (and how to confirm)

1. **Naïve MCP client compatibility.** Not checked: protocol version it negotiates, whether it sends the dual `Accept` header, how a static bearer header or vault secret is attached. Confirm by deploying `/api/mcp`, adding it as an MCP server on a test agent, and asking it to call `earth_index_lookup`. Check the Vercel runtime logs or `onEvent`.
2. **Real Vercel deployment** of the MCP and answer routes. Only tested with local `next start`. Confirm after the first approved deploy with the curl calls in §3.4 against `https://<prod>/api/mcp`.
3. **Neon HTTP driver against real Neon.** The SQL was tested on PGlite with the repo migration; the `neon()` calls only compiled. Confirm once `DATABASE_URL` exists.
4. **Globe performance.** 3,752 merged hexes rendered, but FPS couldn't be measured: the browser pane was hidden and `requestAnimationFrame` was throttled to about 1 fps. Measure on the demo laptop with `/perf`-style data. If it's slow, lower the display resolution or use `pointsMerge`.
5. **`onHexClick` / `onHexHover` with `hexBinMerge={true}`.** The merged mesh carries `__data` = all bins; per-hex picking was not tested. If clicks are needed, use `hexBinMerge={false}` for small sets or `onGlobeClick` + `latLngToCell`.
6. **Vercel limits without Fluid compute** (legacy). Not in the current docs. Irrelevant if Fluid stays on (the default for new projects); check Project → Settings → Functions after import.
7. **deck.gl `_GlobeView` and Cesium.** deck.gl only type-checked; Cesium (asset copy, `CESIUM_BASE_URL`, ion token) not tried.
8. **SkyWatch:** licence text is behind login (the terms article returned 401); archive delivery times aren't published; there's no documented rate limit or ToS for unauthenticated MCP use. Confirm by reading the third-party licences in Explore after a founder creates a free account, and by asking support@skywatch.com.
9. **UP42:** exact estimate responses for real AOIs need an account (`POST /v2/orders/estimate` returns 401 without a token). It's unclear whether a hackathon team passes the compliance check quickly, and no public sales email was found (form only).
10. **Arlula:**
    - Whether self-serve dashboard sign-up still works after the Geostack pivot.
    - The unit of `price:unit_price`: the docs example shows `350` with `price:units: "sqkm"`, possibly cents per km², but this isn't stated.
    - Whether the live API is on the STAC design (the header says `api-version: 2023-08`).

    Confirm by emailing hello@arlula.com or creating a dashboard account and calling `GET /api/test`.
11. **Airbus OneAtlas and Vantor direct price lists.** Not found publicly; ask sales, or rely on SkyWatch and UP42 reseller rates.
12. **Planet licence terms and SkySat archive availability** for small AOIs (25 km² minimum via Planet Select). Needs a Planet sales conversation.
13. **Stripe:** the webhook and polling code paths weren't run against a live or test account. Confirm with Stripe test mode and the Stripe CLI (`stripe trigger checkout.session.completed`) once a founder provides a test key.
