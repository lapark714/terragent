/** OWNER: outbound builder. Catalog group "outreach" (Comms 3, outreach@): context, sends, form touches, follow-ups. */
import { z } from "zod";
import { Playbook } from "../../domain";
import { guarded } from "../../outbound/errors";
import { listFollowups } from "../../outbound/followups";
import { getOutreachContext, recordContactFormTouch, sendOutreachEmail, SKIP_REASONS } from "../../outbound/outreach";
import type { ToolRegistrar } from "../types";

const Vars = z
  .record(z.string(), z.string().max(1000))
  .optional()
  .describe("extra template placeholders you write (e.g. a personal opening line); facts from the report are filled in by the server");

export function register(registrar: ToolRegistrar): void {
  const r = guarded(registrar);

  r.tool(
    "get_outreach_context",
    { prospect_id: z.string(), vars: Vars },
    (a, ctx) => getOutreachContext({ prospectId: a.prospect_id, vars: a.vars, actor: ctx.agent }),
  );

  r.tool(
    "send_outreach_email",
    {
      prospect_id: z.string(),
      kind: z.enum(["outreach", "followup"]).default("outreach").describe("outreach = first touch; followup = only with new information"),
      vars: Vars,
      new_info: z.string().min(20).max(1500).optional().describe("required for followup: the new image or change, in plain words"),
    },
    (a, ctx) => sendOutreachEmail({ prospectId: a.prospect_id, kind: a.kind, vars: a.vars, newInfo: a.new_info, actor: ctx.agent }),
  );

  r.tool(
    "record_contact_form_touch",
    {
      prospect_id: z.string(),
      form_url: z.url({ protocol: /^https?$/ }).describe("the page whose form you used (or skipped)"),
      status: z.enum(["sent", "skipped"]),
      message_text: z.string().min(20).max(5000).optional().describe("required when sent: exactly what you submitted"),
      skip_reason: z.enum(SKIP_REASONS).optional().describe("required when skipped"),
      note: z.string().max(500).optional(),
    },
    (a, ctx) =>
      recordContactFormTouch({
        prospectId: a.prospect_id, formUrl: a.form_url, status: a.status, messageText: a.message_text,
        skipReason: a.skip_reason, note: a.note, actor: ctx.agent,
      }),
  );

  r.tool(
    "list_followups",
    { playbook: Playbook.optional(), limit: z.number().int().min(1).max(50).optional() },
    (a) => listFollowups({ playbook: a.playbook, limit: a.limit }),
  );
}
