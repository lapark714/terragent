/** Test helpers: read recorded fixtures and stub global fetch with a URL router. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { vi } from "vitest";

export const fixture = (name: string, dir = import.meta.dirname) => readFileSync(path.join(dir, name), "utf8");
export const fixtureJson = <T = unknown>(name: string, dir?: string) => JSON.parse(fixture(name, dir)) as T;

export interface Call {
  url: string;
  init: RequestInit;
}

type Reply = Response | ((call: Call) => Response | Promise<Response>);

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const text = (body: string, status = 200) => new Response(body, { status });

/**
 * Stub fetch. The first route whose pattern matches the URL answers (string = substring match);
 * unmatched URLs get a 404. Returns the list of calls for assertions.
 */
export function mockFetch(routes: [string | RegExp, Reply][]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const call = { url, init };
      calls.push(call);
      const hit = routes.find(([p]) => (typeof p === "string" ? url.includes(p) : p.test(url)));
      if (!hit) return text("not found", 404);
      const reply = hit[1];
      return typeof reply === "function" ? reply(call) : reply.clone();
    }),
  );
  return calls;
}
