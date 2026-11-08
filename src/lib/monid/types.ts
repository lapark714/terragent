/** Monid REST shapes we rely on (docs/platform/monid.md §3, https://monid.ai/openapi.json). Dollars are floats. */

export interface MonidMoney {
  value: number;
  currency: string;
}

export interface MonidPriceLeaf {
  type: string; // PER_CALL | PER_RESULT | PER_UNIT | METERED | …
  amount?: MonidMoney;
  flatFee?: MonidMoney;
}

export interface MonidPrice extends MonidPriceLeaf {
  default?: MonidPriceLeaf;
  variants?: { when: Record<string, unknown>; price: MonidPriceLeaf }[];
  tiers?: { label: string; when?: Record<string, unknown>; price: MonidPriceLeaf }[];
  notes?: string[];
}

/** Run input, split by HTTP location exactly as inspect's JSON Schemas describe it. */
export interface MonidInput {
  body?: Record<string, unknown>;
  queryParams?: Record<string, unknown>;
  pathParams?: Record<string, unknown>;
}

export type MonidRunStatus = "READY" | "RUNNING" | "STOPPING" | "COMPLETED" | "FAILED" | "BLOCKED" | "STOPPED" | "TIMED_OUT";

export interface MonidRunBody {
  runId: string;
  status: MonidRunStatus;
  output?: unknown;
  reason?: string;
  providerResponse?: { httpStatus?: number; error?: unknown };
  billing?: { reportedCost?: { value: number; unit: string } };
  cost?: MonidMoney;
  controls?: { controlType?: string }[];
}
