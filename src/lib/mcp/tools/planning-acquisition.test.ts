/** Wiring of the planning and acquisition tools into geocode() and searchFreeScenes() (network mocked). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AgentName, DataSpec } from "../../domain";
import type { ToolRegistrar } from "../types";
import { register as registerAcquisition } from "./acquisition";
import { register as registerPlanning } from "./planning";

const mocks = vi.hoisted(() => ({ geocode: vi.fn(), searchFreeScenes: vi.fn(), requireRequest: vi.fn() }));
vi.mock("../../geo/geocode", () => ({ geocode: mocks.geocode }));
vi.mock("../../imagery/stac", () => ({ searchFreeScenes: mocks.searchFreeScenes }));
vi.mock("../../pipeline/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pipeline/requests")>()),
  requireRequest: mocks.requireRequest,
}));

type Handler = (args: unknown, ctx: { agent: AgentName }) => Promise<unknown>;

function collect(register: (r: ToolRegistrar) => void) {
  const tools = new Map<string, { shape: z.ZodRawShape; handler: Handler }>();
  register({ tool: (name, shape, handler) => void tools.set(name, { shape, handler: handler as Handler }) });
  return (name: string, args: Record<string, unknown>, agent: AgentName) => {
    const t = tools.get(name)!;
    return t.handler(z.object(t.shape).parse(args), { agent });
  };
}

const spec = (recipe: DataSpec["recipe"]) => ({
  aoi: { type: "Polygon", coordinates: [[[-90.1, 29.9], [-90.08, 29.9], [-90.08, 29.92], [-90.1, 29.92], [-90.1, 29.9]]] },
  after: { start: "2026-10-30", end: "2026-11-07" },
  before: { start: "2026-09-30", end: "2026-10-29" },
  max_cloud_pct: 20,
  recipe,
});

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.searchFreeScenes.mockResolvedValue({ before: null, after: null, candidates: { before: [], after: [] }, notes: [] });
});

describe("geocode tool", () => {
  it("puts the cron sourcing agent in Nominatim's periodic lane, interactive agents not", async () => {
    mocks.geocode.mockResolvedValue({ lat: 1, lon: 2, display_name: "x", geocoder: "nominatim", confidence: "medium" });
    const call = collect(registerPlanning);
    await call("geocode", { text: "Baton Rouge, LA" }, "sourcing");
    expect(mocks.geocode).toHaveBeenLastCalledWith("Baton Rouge, LA", { periodic: true });
    await call("geocode", { text: "Baton Rouge, LA" }, "planner");
    expect(mocks.geocode).toHaveBeenLastCalledWith("Baton Rouge, LA", { periodic: false });
  });

  it("explains a miss", async () => {
    mocks.geocode.mockResolvedValue(null);
    expect(await collect(registerPlanning)("geocode", { text: "Nowhere" }, "planner")).toEqual({ error: expect.stringMatching(/No match/) });
  });
});

describe("search_free_scenes tool", () => {
  it("asks for the earliest clear after scene for a flood_extent spec", async () => {
    mocks.requireRequest.mockResolvedValue({ data_spec: spec("flood_extent") });
    await collect(registerAcquisition)("search_free_scenes", { request_id: "req_1" }, "acquisition");
    expect(mocks.searchFreeScenes).toHaveBeenCalledWith({
      bbox: [-90.1, 29.9, -90.08, 29.92],
      after: { start: "2026-10-30", end: "2026-11-07" },
      before: { start: "2026-09-30", end: "2026-10-29" },
      maxCloudPct: 20,
      collection: undefined,
      afterPreference: "earliest",
    });
  });

  it("keeps the latest scene for other recipes, and lets the caller choose", async () => {
    mocks.requireRequest.mockResolvedValue({ data_spec: spec("burn_severity") });
    const call = collect(registerAcquisition);
    await call("search_free_scenes", { request_id: "req_1" }, "acquisition");
    expect(mocks.searchFreeScenes).toHaveBeenLastCalledWith(expect.objectContaining({ afterPreference: "latest" }));
    // The planner searches before it has saved a spec.
    await call("search_free_scenes", { bbox: [-90.1, 29.9, -90.08, 29.92], after: { start: "2026-10-30", end: "2026-11-07" }, after_preference: "earliest" }, "planner");
    expect(mocks.searchFreeScenes).toHaveBeenLastCalledWith(expect.objectContaining({ afterPreference: "earliest", before: null, maxCloudPct: 30 }));
  });
});
