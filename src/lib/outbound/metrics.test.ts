/** First touches AgentMail refused: counted apart from real touches, per playbook and overall. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../db/client";
import { blockedByProvider, getMetrics } from "./metrics";
import { freshDb, insert, reset, seedProspect } from "./testing";

vi.mock("../naive/spend", () => ({ getSpendSummary: vi.fn(async () => ({ total_usd: 0, by_agent: {}, balance_usd: 100 })) }));

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
});

let n = 0;
const outreach = (prospect_id: string, o: Record<string, unknown>) =>
  insert(db, "messages", {
    id: `msg_m${++n}`, direction: "outbound", inbox: "outreach", prospect_id, counterpart_email: "ops@acme.com", kind: "outreach",
    channel: "email_warm", idempotency_key: `k_m${n}`, ...o,
  });

describe("blocked_by_provider", () => {
  it("counts prospects whose only first-touch attempts AgentMail refused, and never as touches", async () => {
    const ramp = await seedProspect(db);
    const rejected = await seedProspect(db, { playbook: "mining" });
    const formLater = await seedProspect(db);
    const ourGate = await seedProspect(db);
    const sent = await seedProspect(db);

    await outreach(ramp, { status: "blocked", blocked_reason: "provider_limit:rate_limit_exceeded" });
    await outreach(rejected, { status: "blocked", blocked_reason: "provider_rejected:account_suspended" });
    // Refused by email, then reached through its contact form: a real touch, not a provider block.
    await outreach(formLater, { status: "blocked", blocked_reason: "provider_limit:cooldown" });
    await outreach(formLater, { status: "sent", channel: "contact_form", counterpart_email: null });
    await outreach(ourGate, { status: "blocked", blocked_reason: "inbox_not_armed" });
    await outreach(sent, { status: "sent" });

    const m = await getMetrics();
    expect(m.by_playbook.disasters).toMatchObject({ first_touches: 2, blocked_by_provider: 1, touches_by_channel: { contact_form: 1, email_warm: 1 } });
    expect(m.by_playbook.mining).toMatchObject({ first_touches: 0, blocked_by_provider: 1 });
    expect(m.overall).toMatchObject({
      blocked_by_provider: 2,
      blocked_by_provider_reasons: { "provider_limit:rate_limit_exceeded": 1, "provider_rejected:account_suspended": 1 },
    });
    expect(m.warnings.join(" ")).toMatch(/2 first touch\(es\) refused by AgentMail/);
  });

  it("uses the prospect cohort window and each prospect's latest refusal", async () => {
    const old = await seedProspect(db, { created_at: new Date(Date.now() - 72 * 3_600_000) });
    const recent = await seedProspect(db);
    await outreach(old, { status: "blocked", blocked_reason: "provider_limit:rate_limit_exceeded" });
    await outreach(recent, { status: "blocked", blocked_reason: "provider_limit:rate_limit_exceeded", created_at: new Date(Date.now() - 60_000) });
    await outreach(recent, { status: "blocked", blocked_reason: "provider_limit:cooldown" });

    expect(await blockedByProvider(new Date(Date.now() - 24 * 3_600_000))).toEqual({
      by_playbook: { disasters: 1 }, by_reason: { "provider_limit:cooldown": 1 }, total: 1,
    });
    expect((await blockedByProvider(new Date(0))).total).toBe(2);
    expect((await getMetrics({ sinceHours: 24 })).warnings.join(" ")).toMatch(/1 first touch/);
  });

  it("is zero, with no warning, when nothing was refused", async () => {
    const m = await getMetrics();
    expect(m.by_playbook.deforestation.blocked_by_provider).toBe(0);
    expect(m.overall.blocked_by_provider).toBe(0);
    expect(m.warnings).toEqual([]);
  });
});
