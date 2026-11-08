import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailApi } from "../agentmail/client";
import type { Db } from "../db/client";
import { setSetting, SETTING } from "../settings";
import { planRoute } from "./inbound";
import { newTextOf, syncNaiveInbox, toInbound } from "./naive-inbox";
import { isSuppressed } from "./optout";
import { sendEmail, type SendEmailArgs } from "./send";
import { fakeMail, memoryDb, resetDb, type FakeMail } from "./testing";

const naive = vi.hoisted(() => ({ send: vi.fn(), messages: vi.fn(), markRead: vi.fn() }));
vi.mock("../naive/client", () => ({ getNaive: async () => ({ emails: naive }) }));
vi.mock("../pipeline/requests", async (orig) => ({ ...(await orig<object>()), handoff: vi.fn(async () => ({ card_id: "crd_1" })) }));

const COLD = "outreach@terragent-qqhrnj.usenaive.ai";
let db: Db;
let mail: FakeMail;
let seq = 0;
const row = (o: Partial<{ id: string; from: string; text: string; guard_reason: string | null; read_at: string | null }> = {}) => ({
  id: `inb_${++seq}`, from: "Pat <pat@acme.com>", to: COLD, subject: "Re: Satellite check", text: "Sounds useful", guard_reason: null, read_at: null, ...o,
});

beforeAll(async () => {
  db = await memoryDb();
});
beforeEach(async () => {
  await resetDb(db);
  mail = fakeMail();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("PUBLIC_BASE_URL", "https://terragent.test");
  vi.stubEnv("COMPANY_POSTAL_ADDRESS", "1 Main St, Town, CA 90000");
  naive.send.mockResolvedValue({ accepted: true });
  naive.messages.mockResolvedValue({ data: [] });
});
afterAll(async () => {
  setMailApi(null);
  vi.unstubAllEnvs();
  await db.close();
});

describe("reading the cold inbox", () => {
  it("keeps only what they wrote, so our quoted footer can't look like an opt-out", () => {
    expect(newTextOf("Maybe $200 a month\n\nOn Mon, Terragent wrote:\n> reply \"stop\"")).toBe("Maybe $200 a month");
    expect(newTextOf("Interested\n--\nPat")).toBe("Interested");
  });

  it("records a reply it can't tie to a prospect without starting work, and honours a stop", async () => {
    expect(await planRoute(toInbound(row(), COLD))).toEqual({ kind: "unmatched" });
    naive.messages.mockResolvedValue({ data: [row({ from: "lee@other.com", text: "stop" })] });
    expect(await syncNaiveInbox()).toEqual({ read: 1, failed: 0 });
    expect(await isSuppressed("lee@other.com")).toBe(true);
    expect(naive.markRead).toHaveBeenCalledTimes(1);
  });

  it("skips what is read or Naïve's own mail, and leaves a failed message unread for the next sync", async () => {
    naive.messages.mockResolvedValue({ data: [row({ read_at: "2026-11-08" }), row({ guard_reason: "own_persona" }), row({ guard_reason: "auto_reply" })] });
    expect(await syncNaiveInbox()).toEqual({ read: 1, failed: 0 });
    expect(await db.query("SELECT 1 FROM messages")).toHaveLength(0);
    naive.markRead.mockClear();
    naive.messages.mockResolvedValue({ data: [{ ...row(), from: undefined as unknown as string }] });
    expect((await syncNaiveInbox()).failed).toBe(1);
    expect(naive.markRead).not.toHaveBeenCalled();
  });
});

describe("sending cold email", () => {
  const cold = async (o: Partial<SendEmailArgs> = {}): Promise<SendEmailArgs> => {
    await db.query("INSERT INTO templates (id, playbook, version, kind, subject, body, status) VALUES ('tpl_c', 'disasters', 'c', 'outreach', 's', 'b', 'approved') ON CONFLICT DO NOTHING");
    return { inbox: "outreach", to: "ops@acme.com", subject: "Satellite check", text: "Hello", kind: "outreach", channel: "email_direct", templateId: "tpl_c", idempotencyKey: `c-${++seq}`, actor: "comms-outreach", ...o };
  };

  it("goes out from the Naïve inbox, never AgentMail, with the postal address and opt-out", async () => {
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "true");
    await setSetting(SETTING.inboxArmed, { outreach: true });
    const res = await sendEmail(await cold());
    expect(res).toMatchObject({ status: "sent", thread_id: "naive:ops@acme.com" });
    expect(mail.send).not.toHaveBeenCalled();
    const [, , body] = naive.send.mock.calls[0];
    expect(Object.keys(body).sort()).toEqual(["subject", "text", "to"]);
    expect(body.text).toContain("1 Main St, Town, CA 90000");
    expect(body.text).toMatch(/Opt out here/);
  });

  it("stays blocked until cold email is approved and the inbox armed", async () => {
    await setSetting(SETTING.inboxArmed, { outreach: true });
    expect(await sendEmail(await cold())).toMatchObject({ status: "blocked", blocked_reason: "direct_email_not_approved" });
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "true");
    await setSetting(SETTING.inboxArmed, {});
    expect(await sendEmail(await cold())).toMatchObject({ status: "blocked", blocked_reason: "inbox_not_armed" });
    expect(naive.send).not.toHaveBeenCalled();
  });
});
