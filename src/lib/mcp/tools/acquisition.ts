/** Catalog group "acquisition": Orchestrator tools (free first, paid only with reasons, orders always held). */
import { z } from "zod";
import { AcquisitionPlan, BBox, DataType, DateRange, type DataSpec } from "../../domain";
import { polygonBbox } from "../../geo/h3";
import { searchFreeScenes } from "../../imagery/stac";
import { saveAcquisitionPlan } from "../../pipeline/acquisition";
import { approveOrder, prepareOrder, requestSupplierQuote } from "../../pipeline/orders";
import { listProviders } from "../../pipeline/providers";
import { requireRequest } from "../../pipeline/requests";
import type { ToolRegistrar } from "../types";

export function register(r: ToolRegistrar): void {
  r.tool(
    "search_free_scenes",
    {
      request_id: z.string().optional().describe("fill bbox, windows and cloud limit from this request's data spec"),
      bbox: BBox.optional(),
      before: DateRange.nullable().optional(),
      after: DateRange.optional(),
      max_cloud_pct: z.number().min(0).max(100).optional(),
      collection: z.enum(["sentinel-2-l2a", "landsat-c2-l2"]).optional(),
    },
    async (a) => {
      const spec = a.request_id ? ((await requireRequest(a.request_id)).data_spec as DataSpec | null) : null;
      const bbox = a.bbox ?? (spec ? polygonBbox(spec.aoi) : undefined);
      const after = a.after ?? spec?.after;
      if (!bbox || !after) return { error: "Give bbox and after, or a request_id with a saved data spec." };
      return searchFreeScenes({
        bbox, after, before: a.before !== undefined ? a.before : (spec?.before ?? null),
        maxCloudPct: a.max_cloud_pct ?? spec?.max_cloud_pct ?? 30, collection: a.collection,
      });
    },
  );

  r.tool(
    "list_providers",
    {
      data_type: DataType.optional(),
      free_only: z.boolean().optional(),
      max_resolution_m: z.number().positive().optional().describe("only providers at least this sharp"),
    },
    async (a) => ({ providers: await listProviders(a), note: "Prices are per km² in each row's currency; UP42 is EUR." }),
  );

  r.tool("save_acquisition_plan", AcquisitionPlan.shape, async (plan, ctx) => saveAcquisitionPlan(plan, ctx.agent));

  r.tool(
    "request_supplier_quote",
    {
      request_id: z.string(),
      provider_id: z.string(),
      product: z.string().min(2).max(200).describe('e.g. "archive optical 30 cm"'),
      reason: z.string().min(20).max(2000).describe("why a real quote helps this request"),
      order_id: z.string().optional().describe("reuse an existing order's thread"),
    },
    async (a, ctx) =>
      requestSupplierQuote({ requestId: a.request_id, providerId: a.provider_id, product: a.product, reason: a.reason, orderId: a.order_id }, ctx.agent),
  );

  r.tool(
    "prepare_paid_order",
    {
      request_id: z.string(),
      provider_id: z.string(),
      product: z.string().min(2).max(200),
      area_km2: z.number().positive(),
      est_cost_usd: z.number().nonnegative(),
      justification: z.string().min(40).max(4000).describe("why free data is not enough"),
      delivery_time: z.string().nullable().optional(),
      license_terms: z.string().nullable().optional(),
      order_id: z.string().optional().describe("an order created by request_supplier_quote"),
    },
    async (a, ctx) =>
      prepareOrder({
        requestId: a.request_id, providerId: a.provider_id, product: a.product, areaKm2: a.area_km2, estCostUsd: a.est_cost_usd,
        justification: a.justification, deliveryTime: a.delivery_time, licenseTerms: a.license_terms, orderId: a.order_id,
      }, ctx.agent),
  );

  r.tool(
    "place_paid_order",
    { order_id: z.string(), reason: z.string().max(1000).optional().describe("why a founder should approve now (e.g. customer paid)") },
    async (a, ctx) => approveOrder({ orderId: a.order_id, reason: a.reason }, ctx.agent),
  );
}
