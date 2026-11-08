/** OWNER: outbound builder. Catalog group "monitoring" (Analytics on cron): due monitors and re-check results. */
import { z } from "zod";
import { guarded } from "../../outbound/errors";
import { listDueMonitors, recordMonitorCheck } from "../../outbound/monitors";
import type { ToolRegistrar } from "../types";

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "list_due_monitors",
    { limit: z.number().int().min(1).max(50).optional().describe("default 20") },
    (a) => listDueMonitors({ limit: a.limit }),
  );

  r.tool(
    "record_monitor_check",
    {
      monitor_id: z.string(),
      value: z.number().nullable().describe("the monitor's metric on the new scene; null if no new clear scene"),
      scene_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().describe("date of the scene checked (YYYY-MM-DD), null if none"),
      scene_id: z.string().optional().describe("collection:item_id of the scene"),
      clear_scene: z.boolean().optional().describe("false if the scene was too cloudy to use (default true)"),
      note: z.string().max(1000).optional(),
      image_urls: z.array(z.url({ protocol: /^https?$/ })).max(4).optional().describe("published image URLs for the follow-up"),
    },
    (a, ctx) =>
      recordMonitorCheck({
        monitorId: a.monitor_id, value: a.value, sceneDate: a.scene_date, sceneId: a.scene_id, clearScene: a.clear_scene,
        note: a.note, imageUrls: a.image_urls, actor: ctx.agent,
      }),
  );
}
