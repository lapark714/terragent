/** OWNER: core builder. Request lifecycle services used by the MCP tools, API routes, webhooks and dashboard. */
import type { AgentName, NewRequestInput, RequestSource, RequestStatus } from "../domain";

export interface RequestRow {
  id: string; source: RequestSource; playbook: string; status: RequestStatus; owner_agent: string | null; priority: "inbound" | "background";
  customer_email: string | null; customer_name: string | null; company: string | null; question: string; location_text: string | null;
  lat: number | null; lon: number | null; aoi: unknown; h3_cells: string[]; data_spec: unknown; acquisition_plan: unknown;
  quote_id: string | null; report_id: string | null; thread_id: string | null; inbox: string | null; is_free_sample: boolean;
  prospect_id: string | null; stage: string | null; card_id: string | null; revisions: number; cost_usd: string | number; price_usd: string | number | null;
  created_at: string; updated_at: string; meta: Record<string, unknown>;
}

export async function createRequest(input: NewRequestInput & { source: RequestSource; playbook?: string; priority?: "inbound" | "background"; threadId?: string; inbox?: string; isFreeSample?: boolean; prospectId?: string; meta?: Record<string, unknown> }): Promise<RequestRow> { throw new Error("not implemented yet"); }
export async function getRequest(id: string): Promise<RequestRow | null> { throw new Error("not implemented yet"); }
export async function setStatus(id: string, status: RequestStatus, actor: string, note?: string): Promise<void> { throw new Error("not implemented yet"); }

/** Hand a request to the next agent: records events, starts the agent (fast lane) or assigns a board card (background lane). */
export async function handoff(args: { requestId: string; from: string; to: AgentName; stage: string; instructions: string }): Promise<{ session_id?: string; card_id?: string }> { throw new Error("not implemented yet"); }

/** Portal, public API and inbound email all call this: create the request and hand it to Comms 2 for screening. */
export async function startInboundRequest(input: NewRequestInput & { source: RequestSource; threadId?: string; inbox?: string }): Promise<RequestRow> { throw new Error("not implemented yet"); }
