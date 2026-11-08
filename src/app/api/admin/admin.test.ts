import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, setDb, type Db } from "@/lib/db/client";
import { migrate } from "@/lib/db/migrate";

vi.mock("@/lib/naive/sessions", () => ({ listPendingApprovals: vi.fn(async () => []), decideApproval: vi.fn(async () => {}) }));

const { POST } = await import("./[action]/route");

let db: Db;
let ip = 0;

function post(action: string, body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", "x-forwarded-for": `10.2.0.${++ip}` };
  if (token !== undefined) headers["x-admin-token"] = token;
  return POST(new Request(`http://localhost/api/admin/${action}`, { method: "POST", headers, body: JSON.stringify(body) }), {
    params: Promise.resolve({ action }),
  });
}

const approveTemplate = { template_id: "tpl_1", decision: "approve", actor: "Laurence", reason: "Copy reviewed" };
const interventions = async () => Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM interventions"))[0].n);

beforeAll(async () => {
  db = await createDb({ memory: true });
  await migrate(db);
  setDb(db);
  await db.query("INSERT INTO templates (id, playbook, version, subject, body) VALUES ('tpl_1', 'disasters', 'v1', 'After the flood', 'Hi')");
});
afterAll(async () => {
  setDb(null);
  await db.close();
});
beforeEach(() => {
  vi.stubEnv("ADMIN_TOKEN", "s3cret-token");
});

describe("POST /api/admin/[action]", () => {
  it("is switched off until ADMIN_TOKEN is set", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    const res = await post("template", approveTemplate, "anything");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("admin_disabled");
  });

  it("refuses a missing or wrong token", async () => {
    expect((await post("template", approveTemplate)).status).toBe(401);
    expect((await post("template", approveTemplate, "s3cret-tokeN")).status).toBe(401);
    expect(await interventions()).toBe(0);
  });

  it("validates the body against the action in the path, not the body", async () => {
    const noReason = await post("template", { ...approveTemplate, reason: "" }, "s3cret-token");
    expect(noReason.status).toBe(400);
    expect((await post("teleport", approveTemplate, "s3cret-token")).status).toBe(400);
    // A body claiming another action is still read as the path's action.
    const res = await post("template", { ...approveTemplate, action: "inbox", inbox: "hello", armed: true }, "s3cret-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: "Template approved" });
    expect(await db.query("SELECT actor, action, ref_id FROM interventions")).toEqual([{ actor: "Laurence", action: "approve_template", ref_id: "tpl_1" }]);
  });

  it("answers a repeated decision with 409 and logs nothing more", async () => {
    const res = await post("template", approveTemplate, "s3cret-token");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("conflict");
    expect(await interventions()).toBe(1);
  });

  it("records a payment from the Money panel, once", async () => {
    await db.query("INSERT INTO requests (id, source, question, price_usd) VALUES ('req_routepay01', 'portal', 'Did it flood?', 29)");
    const body = { request_id: "req_routepay01", amount_usd: 29, actor: "Aiden", reason: "Paid through the Stripe link" };
    const before = await interventions();
    expect((await post("payment", { ...body, amount_usd: "29" }, "s3cret-token")).status).toBe(400);
    const res = await post("payment", body, "s3cret-token");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ done: "Recorded a $29 payment for req_rout." });
    const again = await post("payment", body, "s3cret-token");
    expect(again.status).toBe(409);
    expect(await interventions()).toBe(before + 1);
    expect(await db.query("SELECT amount_usd::float8 AS usd, kind FROM revenue WHERE request_id = 'req_routepay01'")).toEqual([{ usd: 29, kind: "paid" }]);
  });
});
