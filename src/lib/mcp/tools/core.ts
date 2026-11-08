/** Catalog group "core": request lifecycle tools every pipeline agent uses. */
import { z } from "zod";
import { AgentName, DecisionKind, RequestStatus } from "../../domain";
import { logDecision } from "../../events";
import { addNote, handoff, requireRequest, setStatus, STAGES } from "../../pipeline/requests";
import { recordStatedWillingness } from "../../pipeline/revenue";
import { getRequestViewForAgent } from "../../pipeline/view";
import type { ToolRegistrar } from "../types";

const requestId = z.string().describe("req_… id");

/**
 * Finishing statuses have their own tools, so set_status can't skip their checks: delivered comes only from
 * deliver_report and refused only from record_screening. Cancelled is for the coordinator and Comms 2 (customer
 * withdrew or opted out); failed is the coordinator's call.
 */
const FINISHERS: Partial<Record<RequestStatus, readonly AgentName[]>> = {
  delivered: [],
  refused: [],
  cancelled: ["coordinator", "comms-customer", "comms-outreach"],
  failed: ["coordinator"],
};
const VIA_TOOL: Partial<Record<RequestStatus, string>> = { delivered: "deliver_report", refused: "record_screening (allowed=false)" };

export function register(r: ToolRegistrar): void {
  r.tool("get_request", { request_id: requestId }, async ({ request_id }) => getRequestViewForAgent(request_id));

  r.tool("set_status", { request_id: requestId, status: RequestStatus, note: z.string().max(1000).optional() }, async (a, ctx) => {
    const allowed = FINISHERS[a.status];
    if (allowed && !allowed.includes(ctx.agent)) {
      return { error: VIA_TOOL[a.status] ? `Only ${VIA_TOOL[a.status]} sets ${a.status}.` : `Only ${allowed.join(" or ")} can set ${a.status}; add a note and hand off to coordinator.` };
    }
    await setStatus(a.request_id, a.status, ctx.agent, a.note);
    return { request_id: a.request_id, status: a.status };
  });

  r.tool(
    "handoff",
    {
      request_id: requestId,
      to: AgentName,
      stage: z.enum(STAGES).describe("next stage; sets the board status (e.g. planning, acquisition, analysis, verification, delivery)"),
      instructions: z.string().min(5).max(4000).describe("what the next agent should do; never paste customer text here"),
      status: RequestStatus.optional().describe("override the status the stage implies (never a finishing status)"),
      quote_accepted: z.boolean().optional().describe(
        "deprecated (comms-customer only): accepts nothing by itself; record the customer's choice with accept_quote, which starts the work",
      ),
    },
    async (a, ctx) => {
      const lane = await handoff({
        requestId: a.request_id, from: ctx.agent, to: a.to, stage: a.stage, instructions: a.instructions, status: a.status, quoteAccepted: a.quote_accepted,
      });
      return {
        request_id: a.request_id, to: a.to, stage: a.stage, ...lane,
        next: "Handed off. End your turn once every other call you made has returned success (re-issue any approved call that has not run yet).",
      };
    },
  );

  r.tool(
    "add_note",
    {
      request_id: requestId,
      note: z.string().min(1).max(2000),
      stated_willingness_usd: z.number().positive().max(1_000_000).optional().describe(
        "comms-customer only: a price the customer or prospect SAID they would pay (their words in the note); recorded as stated-willingness revenue",
      ),
    },
    async (a, ctx) => {
      if (a.stated_willingness_usd !== undefined && ctx.agent !== "comms-customer") {
        return { error: "Only comms-customer records what a customer said they would pay; add the note without stated_willingness_usd." };
      }
      await addNote(a.request_id, ctx.agent, a.note);
      if (a.stated_willingness_usd === undefined) return { ok: true };
      return { ok: true, ...(await recordStatedWillingness({ requestId: a.request_id, amountUsd: a.stated_willingness_usd, note: a.note, actor: ctx.agent })) };
    },
  );

  r.tool(
    "log_decision",
    {
      request_id: requestId.nullable().optional().describe("omit for company-level decisions"),
      kind: DecisionKind,
      choice: z.string().min(1).max(500),
      reasoning: z.string().min(10).max(4000),
      alternatives: z
        .array(z.object({ option: z.string(), cost_usd: z.number().nullable().optional(), why_not: z.string() }))
        .max(20)
        .optional(),
    },
    async (a, ctx) => {
      if (a.request_id) await requireRequest(a.request_id);
      const id = await logDecision({ requestId: a.request_id ?? null, kind: a.kind, choice: a.choice, reasoning: a.reasoning, alternatives: a.alternatives, agent: ctx.agent });
      return { decision_id: id };
    },
  );
}
