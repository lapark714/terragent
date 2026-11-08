/** OWNER: outbound builder. Catalog group "prospects" (Sourcing agent): Monid lookups, prospects, free samples. */
import { z } from "zod";
import { Playbook, ProspectInput } from "../../domain";
import { monidDiscover, monidRun } from "../../monid/client";
import { guarded } from "../../outbound/errors";
import { createProspect, listProspects, requestFreeSample } from "../../outbound/prospects";
import { truncate } from "../../outbound/util";
import type { ToolRegistrar } from "../types";

const MAX_OUTPUT_CHARS = 20_000;

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "monid_discover",
    {
      q: z.string().min(3).max(300).describe('what you need, e.g. "property managers near a location" or "verified work email"'),
      limit: z.number().int().min(1).max(20).optional(),
    },
    async (a) => ({ endpoints: await monidDiscover(a.q, a.limit ?? 5) }),
  );

  r.tool(
    "monid_run",
    {
      provider: z.string().min(1),
      endpoint: z.string().min(1).describe('e.g. "/v1/company/search"'),
      input: z
        .object({
          body: z.record(z.string(), z.unknown()).optional(),
          queryParams: z.record(z.string(), z.unknown()).optional(),
          pathParams: z.record(z.string(), z.unknown()).optional(),
        })
        .describe("exactly the endpoint's input schema"),
      purpose: z.string().min(5).max(300).describe("why this paid call is needed (logged with its cost)"),
      request_id: z.string().optional(),
    },
    async (a, ctx) => {
      const res = await monidRun({ provider: a.provider, endpoint: a.endpoint, input: a.input, purpose: a.purpose, requestId: a.request_id, agent: ctx.agent });
      const output = JSON.stringify(res.output ?? null);
      return output.length > MAX_OUTPUT_CHARS
        ? { ...res, output: truncate(output, MAX_OUTPUT_CHARS), output_truncated: true }
        : res;
    },
  );

  r.tool(
    "create_prospect",
    {
      ...ProspectInput.shape,
      contact_form_url: z.url({ protocol: /^https?$/ }).nullable().optional().describe("the business's own website contact form, if found"),
    },
    ({ contact_form_url, ...input }, ctx) => createProspect({ input, contactFormUrl: contact_form_url, actor: ctx.agent }),
  );

  r.tool(
    "list_prospects",
    {
      playbook: Playbook.optional(),
      status: z
        .enum(["matched", "sample_requested", "sample_ready", "emailed", "replied", "quoted", "paid", "opted_out", "disqualified"])
        .optional(),
      min_score: z.number().min(0).max(1).optional(),
      limit: z.number().int().min(1).max(100).optional().describe("default 30, highest score first"),
    },
    async (a) => ({ prospects: await listProspects({ playbook: a.playbook, status: a.status, minScore: a.min_score, limit: a.limit }) }),
  );

  r.tool(
    "request_free_sample",
    { prospect_id: z.string() },
    (a, ctx) => requestFreeSample({ prospectId: a.prospect_id, actor: ctx.agent }),
  );
}
