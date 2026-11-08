/**
 * Polite HTTP for public feeds and geocoders: a descriptive User-Agent (never an email address),
 * a timeout on every call, and error messages that never contain secrets (FIRMS puts its key in the URL).
 */
export const USER_AGENT = "Terragent/0.1 (+https://terragent.vercel.app)";

export interface HttpOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  /** Values to scrub from error messages (keys embedded in URLs). */
  secrets?: string[];
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function redact(text: string, secrets: string[] = []): string {
  return secrets.filter(Boolean).reduce((t, s) => t.split(s).join("***"), text);
}

export async function httpText(url: string, opts: HttpOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const where = redact(url.split("?")[0], opts.secrets);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: { "User-Agent": USER_AGENT, ...opts.headers },
      body: opts.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(err);
    throw new Error(`${where}: ${redact(reason, opts.secrets)}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const body = redact(text.replace(/\s+/g, " ").trim().slice(0, 200), opts.secrets);
    throw new HttpError(res.status, `${where}: HTTP ${res.status}${body ? ` ${body}` : ""}`);
  }
  return text;
}

export async function httpJson<T>(url: string, opts: HttpOptions = {}): Promise<T> {
  const text = await httpText(url, { ...opts, headers: { Accept: "application/json", ...opts.headers } });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${redact(url.split("?")[0], opts.secrets)}: response is not JSON`);
  }
}

/** Run `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));
