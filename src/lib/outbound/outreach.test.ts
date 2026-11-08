import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPS } from "../config";
import type { Db } from "../db/client";
import { chooseChannel, isPersonalMailbox, normalizeDomain } from "./channel";
import { listFollowups } from "./followups";
import { getOutreachContext, recordContactFormTouch, sendOutreachEmail } from "./outreach";
import { freshDb, insert, reset, seedProspect, seedReadyProspect, seedRequest, seedTemplate } from "./testing";

const mocks = vi.hoisted(() => {
  class TemplateError extends Error {}
  const fill = (s: string, vars: Record<string, string>) =>
    s.replace(/\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g, (_m, k: string, fb?: string) => {
      const v = vars[k] ?? fb;
      if (!v) throw new TemplateError(`unknown or empty placeholder(s): ${k}`);
      return v;
    });
  return {
    TemplateError,
    fill,
    sendEmail: vi.fn(),
    replyInThread: vi.fn(),
    isSuppressed: vi.fn(),
    upsertCard: vi.fn(),
  };
});
vi.mock("../email/send", () => ({ sendEmail: mocks.sendEmail, replyInThread: mocks.replyInThread }));
vi.mock("../email/optout", () => ({ isSuppressed: mocks.isSuppressed, optOutUrl: async () => "https://terragent.test/unsubscribe?t=tok" }));
vi.mock("../pipeline/reports", () => ({ reportUrl: (t: string) => `https://terragent.test/r/${t}` }));
// The real setStatus (it finishes requests and closes their board card); the board itself is faked.
vi.mock("../pipeline/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../pipeline/requests")>()),
  createRequest: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock("../naive/board", () => ({ upsertCard: mocks.upsertCard }));
vi.mock("../email/templates", () => ({
  AI_DISCLOSURE: "Written by an AI agent.",
  TemplateError: mocks.TemplateError,
  renderOutreach: (a: { template: { subject: string; body: string }; vars: Record<string, string> }) => {
    const text = mocks.fill(a.template.body, a.vars);
    return { subject: mocks.fill(a.template.subject, a.vars), text, html: `<p>${text}</p>` };
  },
  renderFollowup: (a: { newInfo: string; template: { subject: string; body: string }; vars: Record<string, string> }) => {
    const vars = { ...a.vars, new_info: a.newInfo };
    return { subject: mocks.fill(a.template.subject, vars), text: mocks.fill(a.template.body, vars), html: "" };
  },
}));

let db: Db;
let sent = 0;
beforeAll(async () => {
  db = await freshDb();
});
beforeEach(async () => {
  await reset(db);
  vi.clearAllMocks();
  mocks.isSuppressed.mockResolvedValue(false);
  // Records the messages row the way the email module does, so history and caps see it.
  const record = async (a: { prospectId: string; kind: string; channel: string; idempotencyKey: string; to?: string }) => {
    const id = `msg_s${++sent}`;
    await insert(db, "messages", { id, direction: "outbound", inbox: "outreach", prospect_id: a.prospectId, counterpart_email: a.to ?? null, kind: a.kind, channel: a.channel, status: "sent", idempotency_key: a.idempotencyKey, agentmail_message_id: `am_${id}` });
    return { status: "sent", message_id: id, thread_id: "thd_1" };
  };
  mocks.sendEmail.mockImplementation(record);
  mocks.replyInThread.mockImplementation(record);
  mocks.upsertCard.mockImplementation(async (c: { key: string; status?: string }) => ({ id: `card_${c.key}`, status: c.status ?? "todo" }));
});
afterEach(() => {
  vi.unstubAllEnvs();
});

/** They wrote to us first → warm. */
async function makeWarm(email: string) {
  await insert(db, "messages", { id: `msg_in${++sent}`, direction: "inbound", inbox: "hello", counterpart_email: email, status: "received", kind: "customer" });
}

describe("channel selection", () => {
  it("follows the NOTES matrix", () => {
    expect(chooseChannel({ email: "a@acme.com", warm: true, directApproved: false }).channel).toBe("email_warm");
    expect(chooseChannel({ email: "a@acme.com", warm: false, directApproved: true }).channel).toBe("email_direct");
    expect(chooseChannel({ email: "a@gmail.com", warm: false, directApproved: true }).channel).toBe("contact_form");
    expect(chooseChannel({ email: "a@acme.com", warm: false, directApproved: false }).channel).toBe("contact_form");
    expect(chooseChannel({ email: null, warm: true, directApproved: true }).channel).toBe("contact_form");
  });

  it("reads OUTREACH_DIRECT_EMAIL_APPROVED when not given", () => {
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "true");
    expect(chooseChannel({ email: "a@acme.com", warm: false }).channel).toBe("email_direct");
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "false");
    expect(chooseChannel({ email: "a@acme.com", warm: false }).channel).toBe("contact_form");
  });

  it("recognises consumer mailboxes and normalises domains", () => {
    expect(["x@yahoo.co.uk", "x@hotmail.fr", "x@ICLOUD.com", "x@gmx.de"].every(isPersonalMailbox)).toBe(true);
    expect(isPersonalMailbox("x@acme.com")).toBe(false);
    expect(normalizeDomain("https://www.Acme.com/contact?x=1")).toBe("acme.com");
    expect(normalizeDomain("localhost")).toBeNull();
  });
});

describe("getOutreachContext", () => {
  it("refuses without an approved template for the playbook", async () => {
    const { prospectId } = await seedReadyProspect(db);
    await seedTemplate(db, { status: "draft" });
    await expect(getOutreachContext({ prospectId })).rejects.toThrow("no approved template — a founder must approve one in the dashboard");
  });

  it("refuses until the sample report passed verification", async () => {
    const { prospectId, requestId } = await seedReadyProspect(db);
    await seedTemplate(db);
    await db.query("UPDATE reports SET verifier_status = 'pending' WHERE request_id = $1", [requestId]);
    await expect(getOutreachContext({ prospectId })).rejects.toThrow(/not verified \(verifier_status pending\)/);
  });

  it("defaults cold prospects to their contact form, with the rendered text to paste", async () => {
    const { prospectId } = await seedReadyProspect(db, { contact_form_url: "https://acme.test/contact" });
    await seedTemplate(db);
    const c = await getOutreachContext({ prospectId, vars: { finding: "agent cannot override this" } });
    expect(c.channel).toBe("contact_form");
    expect(c).toMatchObject({ contact_form: { url: "https://acme.test/contact", reply_to: expect.stringContaining("@") } });
    expect(c.vars.finding).toMatch(/^Standing water covers the north lot\. \(mndwi_delta: 0\.31\)$/);
    expect(c.rendered.text).toContain("https://terragent.test/r/");
    expect(c.rendered.text).toContain("$49 per site per month");
    expect(c.template.placeholders).toEqual(["asset", "contact_name", "finding", "report_url", "price"]);
    expect(c.touches_left_today).toBe(CAPS.outreachTouchesPerDay);
  });

  it("points at the full page when the business only has a shared-host page", async () => {
    const { prospectId } = await seedReadyProspect(db, { domain: null, meta: { website: "https://www.facebook.com/acme" } });
    await seedTemplate(db);
    expect(await getOutreachContext({ prospectId })).toMatchObject({
      channel: "contact_form",
      contact_form: { url: null, find_it: "Find their contact form or message option on https://www.facebook.com/acme" },
    });
  });

  it("allows one first touch per business across playbooks", async () => {
    const a = await seedReadyProspect(db, { domain: "same.biz", company: "Same Biz" });
    const b = await seedReadyProspect(db, { domain: "same.biz", company: "Same Biz Minerals", playbook: "mining" });
    await seedTemplate(db);
    await seedTemplate(db, { playbook: "mining" });
    await recordContactFormTouch({ prospectId: a.prospectId, formUrl: "https://same.biz/contact", status: "sent", messageText: "Hello from Terragent, an AI agent: we checked your site", actor: "comms-outreach" });
    await expect(getOutreachContext({ prospectId: b.prospectId })).rejects.toThrow(new RegExp(`already contacted as prospect ${a.prospectId} \\(disasters\\).*one touch per business`));
    const again = await recordContactFormTouch({ prospectId: b.prospectId, formUrl: "https://same.biz/contact", status: "sent", messageText: "A second message for the same business", actor: "comms-outreach" });
    expect(again.warnings).toEqual([`this business was already contacted as prospect ${a.prospectId} (disasters): one touch per business`]);
  });

  it("uses email_warm for someone who wrote to us", async () => {
    const { prospectId } = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    await seedTemplate(db);
    await makeWarm("OPS@warm.test");
    const c = await getOutreachContext({ prospectId });
    expect(c.channel).toBe("email_warm");
    expect(c).toHaveProperty("send_with");
  });

  it("turns template gaps into an actionable error", async () => {
    const { prospectId } = await seedReadyProspect(db);
    await seedTemplate(db, { body: "Hi {{nickname}}" });
    await expect(getOutreachContext({ prospectId })).rejects.toThrow(/could not be filled: .*nickname.*Pass the missing values in vars/);
    expect((await getOutreachContext({ prospectId, vars: { nickname: "Dee" } })).rendered.text).toBe("Hi Dee");
  });
});

describe("sendOutreachEmail", () => {
  it("sends a warm first touch once and marks the prospect emailed with the template version", async () => {
    const { prospectId, requestId } = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    const tpl = await seedTemplate(db, { version: "v7" });
    await makeWarm("ops@warm.test");
    const res = await sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" });
    expect(res).toMatchObject({ status: "sent", channel: "email_warm", touches_left_today: CAPS.outreachTouchesPerDay - 1 });
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      inbox: "outreach", to: "ops@warm.test", kind: "outreach", channel: "email_warm", templateId: tpl,
      prospectId, requestId, idempotencyKey: `outreach:${prospectId}`, actor: "comms-outreach",
    }));
    const [p] = await db.query<{ status: string; channel: string; message_version: string; outreach_thread_id: string }>(
      "SELECT status, channel, message_version, outreach_thread_id FROM prospects WHERE id = $1", [prospectId]);
    expect(p).toEqual({ status: "emailed", channel: "email_warm", message_version: "v7", outreach_thread_id: "thd_1" });

    await expect(sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" })).rejects.toThrow(/already contacted/);
  });

  it("sends direct cold email only when the flag is on", async () => {
    const { prospectId } = await seedReadyProspect(db);
    await seedTemplate(db);
    await expect(sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" })).rejects.toThrow(/channel is contact_form/);
    vi.stubEnv("OUTREACH_DIRECT_EMAIL_APPROVED", "true");
    expect((await sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" })).channel).toBe("email_direct");
  });

  it("enforces the daily outreach cap across channels", async () => {
    const { prospectId } = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    await seedTemplate(db);
    await makeWarm("ops@warm.test");
    await db.query(
      `INSERT INTO messages (id, direction, inbox, prospect_id, kind, status, channel)
       SELECT 'msg_cap' || g, 'outbound', 'outreach', 'pro_other', 'outreach', 'sent', 'contact_form' FROM generate_series(1, $1) g`,
      [CAPS.outreachTouchesPerDay],
    );
    await expect(sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" })).rejects.toThrow(/daily outreach cap reached/);
    expect(mocks.sendEmail).not.toHaveBeenCalled();
  });

  it("leaves the prospect untouched when the email module blocks the send", async () => {
    const { prospectId } = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    await seedTemplate(db);
    await makeWarm("ops@warm.test");
    mocks.sendEmail.mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "inbox_not_armed" });
    expect(await sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" })).toMatchObject({ status: "blocked", blocked_reason: "inbox_not_armed" });
    const [p] = await db.query<{ status: string }>("SELECT status FROM prospects WHERE id = $1", [prospectId]);
    expect(p.status).toBe("sample_requested");
  });

  it("refuses opted-out and replied prospects", async () => {
    const replied = await seedReadyProspect(db, { status: "replied" });
    const optedOut = await seedReadyProspect(db);
    await seedTemplate(db);
    await expect(sendOutreachEmail({ prospectId: replied.prospectId, kind: "outreach", actor: "comms-outreach" })).rejects.toThrow(/comms-customer owns/);
    mocks.isSuppressed.mockResolvedValue(true);
    await expect(getOutreachContext({ prospectId: optedOut.prospectId })).rejects.toThrow(/opted out/);
  });
});

describe("follow-ups", () => {
  async function touchedWarmProspect() {
    const ready = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    await seedTemplate(db);
    await seedTemplate(db, { playbook: "all", kind: "followup", subject: "New image for {{company}}", body: "{{new_info}} {{report_url}}" });
    await makeWarm("ops@warm.test");
    await sendOutreachEmail({ prospectId: ready.prospectId, kind: "outreach", actor: "comms-outreach" });
    await db.query("UPDATE messages SET created_at = now() - interval '2 days' WHERE prospect_id = $1", [ready.prospectId]);
    return ready;
  }

  it("never sends a plain reminder", async () => {
    const { prospectId } = await touchedWarmProspect();
    expect((await listFollowups({})).followups).toEqual([]);
    await expect(sendOutreachEmail({ prospectId, kind: "followup", newInfo: "Just checking in on our last note", actor: "comms-outreach" }))
      .rejects.toThrow(/no new information/);
  });

  it("lists and sends a follow-up when a change was detected at the asset after the last touch", async () => {
    const { prospectId } = await touchedWarmProspect();
    await insert(db, "earth_index", { h3_cell: "88291a8b6dfffff", h3_res: 8, layer: "disasters", metric: "mndwi_delta", value: 0.4, observed_at: "2026-11-09", source: "sentinel-2-l2a:S2C", change_flag: true });
    // Point the asset at that cell's centre so the cell matches.
    const { cellToLatLng } = await import("h3-js");
    const [lat, lon] = cellToLatLng("88291a8b6dfffff");
    await db.query("UPDATE prospects SET asset_lat = $2, asset_lon = $3 WHERE id = $1", [prospectId, lat, lon]);

    const { followups } = await listFollowups({});
    expect(followups).toHaveLength(1);
    expect(followups[0]).toMatchObject({ prospect_id: prospectId, channel: "email_warm", new_info: [{ kind: "change_detected" }] });

    const [first] = await db.query<{ am: string }>("SELECT agentmail_message_id AS am FROM messages WHERE prospect_id = $1", [prospectId]);
    const res = await sendOutreachEmail({ prospectId, kind: "followup", newInfo: "Water spread to the south lot on 9 Nov (MNDWI +0.4).", actor: "comms-outreach" });
    expect(res.status).toBe("sent");
    expect(mocks.replyInThread).toHaveBeenCalledWith(expect.objectContaining({
      kind: "followup", inReplyToMessageId: first.am, idempotencyKey: `followup:${prospectId}:1`, text: expect.stringContaining("Water spread"),
    }));
    expect((await listFollowups({})).followups).toEqual([]);
  });

  it("ignores old scenes indexed after the touch, and sees changes in the asset's neighbouring cells", async () => {
    const { prospectId } = await touchedWarmProspect();
    const [p] = await db.query<{ asset_lat: number; asset_lon: number }>("SELECT asset_lat, asset_lon FROM prospects WHERE id = $1", [prospectId]);
    const { gridDisk, latLngToCell } = await import("h3-js");
    const cell = latLngToCell(p.asset_lat, p.asset_lon, 8);
    const row = { h3_res: 8, layer: "disasters", metric: "mndwi_delta", value: 0.4, source: "sentinel-2-l2a:S2C" };
    // An archive scene older than the sample's own (2026-11-06), analysed now for someone else: not new to them.
    await insert(db, "earth_index", { ...row, h3_cell: cell, observed_at: "2026-09-01", change_flag: true });
    expect((await listFollowups({})).followups).toEqual([]);

    await insert(db, "earth_index", { ...row, h3_cell: gridDisk(cell, 1).find((c) => c !== cell)!, observed_at: "2026-11-10", change_flag: true });
    const { followups } = await listFollowups({});
    expect(followups[0].new_info).toEqual([expect.objectContaining({ kind: "change_detected", observed_at: "2026-11-10" })]);
  });

  it("skips contact-form prospects (one touch per business)", async () => {
    const { prospectId } = await seedReadyProspect(db, { status: "emailed", channel: "contact_form" });
    expect(await listFollowups({})).toMatchObject({ followups: [], skipped_contact_form: 1 });
    expect(prospectId).toBeTruthy();
  });
});

describe("recordContactFormTouch", () => {
  it("records a sent touch, marks the prospect contacted via contact_form, and dedupes identical retries", async () => {
    const { prospectId } = await seedReadyProspect(db);
    await seedTemplate(db, { version: "v2" });
    const args = { prospectId, formUrl: "https://acme.test/contact", status: "sent" as const, messageText: "Hello from Terragent, an AI agent: we checked your site…", actor: "comms-outreach" };
    const res = await recordContactFormTouch(args);
    expect(res).toMatchObject({ duplicate: false, status: "sent", warnings: [] });
    expect(await recordContactFormTouch(args)).toMatchObject({ duplicate: true });

    const msgs = await db.query<{ channel: string; counterpart_url: string; status: string; kind: string }>("SELECT channel, counterpart_url, status, kind FROM messages");
    expect(msgs).toEqual([{ channel: "contact_form", counterpart_url: "https://acme.test/contact", status: "sent", kind: "outreach" }]);
    const [p] = await db.query<{ status: string; channel: string; message_version: string }>("SELECT status, channel, message_version FROM prospects WHERE id = $1", [prospectId]);
    expect(p).toEqual({ status: "emailed", channel: "contact_form", message_version: "v2" });
  });

  it("a no-solicitation notice disqualifies; a CAPTCHA skip keeps the prospect", async () => {
    const a = await seedReadyProspect(db);
    const b = await seedReadyProspect(db);
    await recordContactFormTouch({ prospectId: a.prospectId, formUrl: "https://a.test/contact", status: "skipped", skipReason: "no_solicitation_notice", actor: "comms-outreach" });
    await recordContactFormTouch({ prospectId: b.prospectId, formUrl: "https://b.test/contact", status: "skipped", skipReason: "captcha", actor: "comms-outreach" });
    const rows = await db.query<{ id: string; status: string; meta: Record<string, unknown> }>("SELECT id, status, meta FROM prospects ORDER BY id");
    expect(rows.find((r) => r.id === a.prospectId)?.status).toBe("disqualified");
    expect(rows.find((r) => r.id === b.prospectId)).toMatchObject({ status: "sample_requested", meta: { contact_form_skipped: "captcha" } });
    const [m] = await db.query<{ status: string; blocked_reason: string }>("SELECT status, blocked_reason FROM messages WHERE prospect_id = $1", [b.prospectId]);
    expect(m).toEqual({ status: "skipped", blocked_reason: "captcha" });
  });

  it("a no-solicitation notice disqualifies the business under every playbook", async () => {
    const a = await seedReadyProspect(db, { domain: "nosales.biz", company: "No Sales Inc" });
    const b = await seedReadyProspect(db, { domain: "nosales.biz", company: "No Sales Minerals", playbook: "mining" });
    const other = await seedReadyProspect(db);
    await seedTemplate(db, { playbook: "mining" });
    const res = await recordContactFormTouch({ prospectId: a.prospectId, formUrl: "https://nosales.biz/contact", status: "skipped", skipReason: "no_solicitation_notice", actor: "comms-outreach" });
    expect(res).toMatchObject({ status: "skipped", disqualified: expect.arrayContaining([a.prospectId, b.prospectId]) });
    const rows = await db.query<{ id: string; status: string }>("SELECT id, status FROM prospects");
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [a.prospectId]: "disqualified", [b.prospectId]: "disqualified", [other.prospectId]: "sample_requested" });
    await expect(getOutreachContext({ prospectId: b.prospectId })).rejects.toThrow(/prospect is disqualified/);
  });

  it("flags touches that broke a rule, and leaves closed or replied prospects' status alone", async () => {
    await seedTemplate(db);
    const text = "Hello from Terragent, an AI agent: we checked your site";
    const touch = (prospectId: string) => recordContactFormTouch({ prospectId, formUrl: `https://${prospectId}.test/contact`, status: "sent", messageText: text, actor: "comms-outreach" });

    const replied = await seedReadyProspect(db, { status: "replied" });
    expect((await touch(replied.prospectId)).warnings).toEqual(["prospect has replied: comms-customer owns the conversation"]);
    const unverified = await seedReadyProspect(db);
    await db.query("UPDATE reports SET verifier_status = 'fail' WHERE request_id = $1", [unverified.requestId]);
    expect((await touch(unverified.prospectId)).warnings).toEqual(["no verified sample report: first touches wait for a verifier pass"]);
    const noSample = await seedProspect(db);
    expect((await touch(noSample)).warnings).toEqual(["no verified sample report: first touches wait for a verifier pass"]);
    const disqualified = await seedReadyProspect(db, { status: "disqualified" });
    mocks.isSuppressed.mockResolvedValue(true);
    expect((await touch(disqualified.prospectId)).warnings).toEqual(["prospect is disqualified: it must not be contacted", "contact has opted out: it must not be contacted"]);

    const status = async (id: string) => (await db.query<{ status: string }>("SELECT status FROM prospects WHERE id = $1", [id]))[0].status;
    expect([await status(replied.prospectId), await status(disqualified.prospectId), await status(noSample)]).toEqual(["replied", "disqualified", "emailed"]);
    const events = await db.query<{ payload: { rule_break: boolean } }>("SELECT payload FROM events WHERE type = 'outreach.contact_form'");
    expect(events.map((e) => e.payload.rule_break)).toEqual([true, true, true, true]);
  });

  it("requires the submitted text or a skip reason, and warns on a second touch", async () => {
    const { prospectId } = await seedReadyProspect(db);
    await expect(recordContactFormTouch({ prospectId, formUrl: "https://a.test", status: "sent", actor: "x" })).rejects.toThrow(/message_text/);
    await expect(recordContactFormTouch({ prospectId, formUrl: "https://a.test", status: "skipped", actor: "x" })).rejects.toThrow(/skip_reason/);
    await recordContactFormTouch({ prospectId, formUrl: "https://a.test", status: "sent", messageText: "first message text here", actor: "x" });
    const second = await recordContactFormTouch({ prospectId, formUrl: "https://a.test/other", status: "sent", messageText: "second message text here", actor: "x" });
    expect(second.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/one touch per business/), expect.stringMatching(/no approved template/)]));
  });
});

describe("finishing the request comms-outreach holds", () => {
  const card = (requestId: string) => ({ key: `req:${requestId}:5:comms-outreach`, title: `${requestId} · outreach`, body: "brief", assignee: "comms-outreach" });

  /** What the verifier's handoff leaves behind: comms-outreach owns it at stage outreach, status delivering, card open. */
  async function heldByOutreach(requestId: string) {
    await db.query("UPDATE requests SET owner_agent = 'comms-outreach', stage = 'outreach', status = 'delivering', meta = $2 WHERE id = $1",
      [requestId, JSON.stringify({ card: card(requestId) })]);
  }
  const statusOf = async (id: string) => (await db.query<{ status: string }>("SELECT status FROM requests WHERE id = $1", [id]))[0].status;
  const cardClosed = (requestId: string) =>
    expect(mocks.upsertCard).toHaveBeenCalledWith(expect.objectContaining({ key: card(requestId).key, status: "done", note: expect.stringMatching(/^(delivered|cancelled): /) }));
  const formTouch = (prospectId: string, over: Partial<Parameters<typeof recordContactFormTouch>[0]> = {}) =>
    recordContactFormTouch({ prospectId, formUrl: "https://acme.test/contact", status: "sent", messageText: "Hello from Terragent, an AI agent: we checked your site", actor: "comms-outreach", ...over });

  it("a sent contact-form touch delivers the free sample and closes its card", async () => {
    const { prospectId, requestId } = await seedReadyProspect(db);
    await seedTemplate(db);
    await heldByOutreach(requestId);
    const res = await formTouch(prospectId);
    expect(res.closed).toEqual([{ request_id: requestId, status: "delivered" }]);
    expect(await statusOf(requestId)).toBe("delivered");
    cardClosed(requestId);
    // An identical retry is a no-op for the request too.
    expect(await formTouch(prospectId)).toMatchObject({ duplicate: true, closed: [] });
  });

  it("a final form skip cancels the sample; a form error leaves it open for a retry", async () => {
    const captcha = await seedReadyProspect(db);
    const broken = await seedReadyProspect(db);
    await heldByOutreach(captcha.requestId);
    await heldByOutreach(broken.requestId);
    expect((await formTouch(captcha.prospectId, { status: "skipped", skipReason: "captcha", messageText: undefined })).closed)
      .toEqual([{ request_id: captcha.requestId, status: "cancelled" }]);
    expect((await formTouch(broken.prospectId, { status: "skipped", skipReason: "form_error", messageText: undefined })).closed).toEqual([]);
    expect([await statusOf(captcha.requestId), await statusOf(broken.requestId)]).toEqual(["cancelled", "delivering"]);
    const [ev] = await db.query<{ payload: { to: string; note: string } }>("SELECT payload FROM events WHERE request_id = $1 AND type = 'status.changed'", [captcha.requestId]);
    expect(ev.payload).toMatchObject({ to: "cancelled", note: "Not contacted: contact form skipped (captcha)." });
  });

  it("a sent first-touch email delivers the sample; a blocked one leaves it open", async () => {
    const sent = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    const blocked = await seedReadyProspect(db, { contact_email: "ops@held.test" });
    await seedTemplate(db);
    await makeWarm("ops@warm.test");
    await makeWarm("ops@held.test");
    await heldByOutreach(sent.requestId);
    await heldByOutreach(blocked.requestId);
    expect((await sendOutreachEmail({ prospectId: sent.prospectId, kind: "outreach", actor: "comms-outreach" })).closed)
      .toEqual([{ request_id: sent.requestId, status: "delivered" }]);
    mocks.sendEmail.mockResolvedValueOnce({ status: "blocked", message_id: "msg_b", blocked_reason: "provider_limit:cooldown" });
    expect(await sendOutreachEmail({ prospectId: blocked.prospectId, kind: "outreach", actor: "comms-outreach" })).toMatchObject({ status: "blocked", closed: [] });
    expect([await statusOf(sent.requestId), await statusOf(blocked.requestId)]).toEqual(["delivered", "delivering"]);
    cardClosed(sent.requestId);
  });

  it("leaves a sample alone while another agent still holds it", async () => {
    const { prospectId, requestId } = await seedReadyProspect(db);
    await seedTemplate(db);
    await db.query("UPDATE requests SET owner_agent = 'verifier', status = 'verifying' WHERE id = $1", [requestId]);
    expect((await formTouch(prospectId)).closed).toEqual([]);
    expect(await statusOf(requestId)).toBe("verifying");
  });

  it("a re-handed run for a business already contacted, or one that must not be, finishes instead of looping", async () => {
    await seedTemplate(db);
    const done = await seedReadyProspect(db);
    await heldByOutreach(done.requestId);
    await formTouch(done.prospectId);
    // A sample touched before touches finished requests, re-handed by the coordinator: still open, touch on record.
    await db.query("UPDATE requests SET status = 'delivering' WHERE id = $1", [done.requestId]);
    await expect(getOutreachContext({ prospectId: done.prospectId, actor: "comms-outreach" }))
      .rejects.toThrow(new RegExp(`already contacted .*request ${done.requestId} closed as delivered`));
    expect(await statusOf(done.requestId)).toBe("delivered");

    const sibling = await seedReadyProspect(db, { domain: "acme-dup.test" });
    const twin = await seedReadyProspect(db, { domain: "acme-dup.test", playbook: "mining" });
    await seedTemplate(db, { playbook: "mining" });
    await formTouch(sibling.prospectId, { formUrl: "https://acme-dup.test/contact" });
    await heldByOutreach(twin.requestId);
    await expect(getOutreachContext({ prospectId: twin.prospectId, actor: "comms-outreach" })).rejects.toThrow(/one touch per business \(request .* closed as cancelled/);

    const gone = await seedReadyProspect(db, { status: "disqualified" });
    await heldByOutreach(gone.requestId);
    await expect(getOutreachContext({ prospectId: gone.prospectId, actor: "comms-outreach" })).rejects.toThrow(/prospect is disqualified: do not contact \(request/);
    expect([await statusOf(twin.requestId), await statusOf(gone.requestId)]).toEqual(["cancelled", "cancelled"]);

    // Gates a founder or time can clear never finish anything.
    const unverified = await seedReadyProspect(db);
    await heldByOutreach(unverified.requestId);
    await db.query("UPDATE reports SET verifier_status = 'pending' WHERE request_id = $1", [unverified.requestId]);
    await expect(getOutreachContext({ prospectId: unverified.prospectId })).rejects.toThrow(/not verified/);
    expect(await statusOf(unverified.requestId)).toBe("delivering");
  });

  it("a sent follow-up delivers the monitor follow-up request comms-outreach was handed", async () => {
    const { prospectId, requestId } = await seedReadyProspect(db, { contact_email: "ops@warm.test" });
    await seedTemplate(db);
    await seedTemplate(db, { playbook: "all", kind: "followup", subject: "New image for {{company}}", body: "{{new_info}} {{report_url}}" });
    await makeWarm("ops@warm.test");
    await heldByOutreach(requestId);
    await sendOutreachEmail({ prospectId, kind: "outreach", actor: "comms-outreach" });
    await db.query("UPDATE messages SET created_at = now() - interval '2 days' WHERE prospect_id = $1", [prospectId]);

    const followup = await seedRequest(db, { source: "monitor", prospect_id: prospectId });
    const customers = await seedRequest(db, { source: "monitor", prospect_id: prospectId, owner_agent: "comms-customer", status: "delivering" });
    await heldByOutreach(followup);
    await insert(db, "events", { type: "monitor.followup", actor: "analytics", request_id: followup, payload: { prospect_id: prospectId, new_info: "New clear scene 2026-11-12" } });
    const res = await sendOutreachEmail({ prospectId, kind: "followup", newInfo: "A new clear scene on 12 Nov shows the water has receded.", actor: "comms-outreach" });
    expect(res).toMatchObject({ status: "sent", closed: [{ request_id: followup, status: "delivered" }] });
    expect([await statusOf(followup), await statusOf(customers), await statusOf(requestId)]).toEqual(["delivered", "delivering", "delivered"]);

    // Nothing new any more: a second follow-up request for it is cancelled, not left for the coordinator.
    const stale = await seedRequest(db, { source: "monitor", prospect_id: prospectId });
    await heldByOutreach(stale);
    await expect(sendOutreachEmail({ prospectId, kind: "followup", newInfo: "Just checking in on our last note, any thoughts?", actor: "comms-outreach" }))
      .rejects.toThrow(/no new information .*closed as cancelled/);
    expect(await statusOf(stale)).toBe("cancelled");
  });
});
