import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getNaive, NaiveOfflineError, setNaive } from "./client";
import { listCards, upsertCard } from "./board";
import { fileBytes, fileUrl } from "./files";

// A client that fails loudly if anything reaches it: offline mode must never call Naïve.
const tripwire = new Proxy({}, { get: () => { throw new Error("Naïve client was touched in offline mode"); } });

describe("offline mode never reaches Naïve", () => {
  beforeEach(() => {
    vi.stubEnv("TERRAGENT_OFFLINE", "1");
    vi.stubEnv("VERCEL_ENV", "");
    setNaive(tripwire as never);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    setNaive(null);
  });

  it("getNaive() refuses (backstop for every path)", async () => {
    await expect(getNaive()).rejects.toBeInstanceOf(NaiveOfflineError);
  });

  it("board cards are local: an assigned todo card does not wake a real agent", async () => {
    const card = await upsertCard({ key: "req_x:1:planner", title: "Plan req_x", body: "…", assignee: "planner" });
    expect(card.id).toMatch(/^crd_offline_/);
    expect(card).toMatchObject({ status: "todo", assignee: "planner" });
    const mirror = await upsertCard({ key: "req_x:mirror", title: "Screen req_x", body: "…", assignee: "comms-customer", mirror: true });
    expect(mirror).toMatchObject({ status: "doing", assignee: null });
    expect(await listCards()).toEqual([]);
  });

  it("files refuse instead of minting production links", async () => {
    await expect(fileUrl("fil_abc")).rejects.toBeInstanceOf(NaiveOfflineError);
    await expect(fileBytes("fil_abc")).rejects.toBeInstanceOf(NaiveOfflineError);
  });

  it("production is never offline, even with the flag set", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(upsertCard({ key: "k", title: "t", body: "b", assignee: null, mirror: true })).rejects.not.toBeInstanceOf(NaiveOfflineError);
  });
});
