/** Catalog group "planning": Brain 1 (Planner) tools. */
import { z } from "zod";
import { DataSpec, Polygon } from "../../domain";
import { geocode } from "../../geo/geocode";
import { lookupEarthIndex } from "../../pipeline/earth-index";
import { requireRequest } from "../../pipeline/requests";
import { saveDataSpec } from "../../pipeline/specs";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool("geocode", { text: z.string().min(2).max(500).describe("address or place name") }, async ({ text }, ctx) => {
    // Sourcing runs on cron: Nominatim's policy puts scheduled callers in a slower lane (4/min), see geocode.ts.
    const hit = await geocode(text, { periodic: ctx.agent === "sourcing" });
    return hit ?? { error: `No match for "${text}". Try a simpler place name, or ask the customer.` };
  });

  r.tool(
    "earth_index_lookup",
    {
      request_id: z.string().optional().describe("use this request's AOI (or point) when no geometry is given"),
      lat: z.number().min(-90).max(90).optional(),
      lon: z.number().min(-180).max(180).optional(),
      aoi: Polygon.optional(),
      metric: z.string().optional().describe("e.g. ndvi_mean, dnbr_mean"),
      max_age_days: z.number().int().positive().max(3650).optional(),
      res: z.number().int().min(5).max(10).optional().describe("pin one H3 resolution (default: 7–9 around a point)"),
    },
    async (a) => {
      let { lat, lon, aoi } = a;
      if (a.request_id && !aoi && lat === undefined) {
        const req = await requireRequest(a.request_id);
        aoi = (req.aoi as Polygon | null) ?? undefined;
        lat = req.lat ?? undefined;
        lon = req.lon ?? undefined;
      }
      return lookupEarthIndex({ lat, lon, aoi, metric: a.metric, maxAgeDays: a.max_age_days, res: a.res });
    },
  );

  r.tool("save_data_spec", DataSpec.shape, async (spec, ctx) => ({
    ...(await saveDataSpec(spec, ctx.agent)),
    next: "Hand off to acquisition (stage acquisition).",
  }));
}
