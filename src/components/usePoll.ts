"use client";
/**
 * Polls a JSON endpoint while the tab is visible. Starts from server-rendered data when given.
 * `merge(previous, next)` may keep parts of the previous response (e.g. the last good panels while the database is paused).
 */
import { useCallback, useEffect, useState } from "react";

export interface Poll<T> {
  data: T | null;
  /** When the last successful response arrived (ms epoch), null until the first client fetch. */
  updatedAt: number | null;
  error: string | null;
  refresh: () => void;
}

export function usePoll<T>(url: string, intervalMs: number, initial: T | null = null, merge?: (previous: T | null, next: T) => T): Poll<T> {
  const [state, setState] = useState<{ data: T | null; updatedAt: number | null; error: string | null }>({
    data: initial,
    updatedAt: null,
    error: null,
  });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const res = await fetch(url, { cache: "no-store" });
          if (!res.ok) throw new Error(`The server answered ${res.status}`);
          const data = (await res.json()) as T;
          if (!cancelled) setState((s) => ({ data: merge ? merge(s.data, data) : data, updatedAt: Date.now(), error: null }));
        } catch (e) {
          if (!cancelled) setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e) }));
        }
      }
      if (!cancelled) timer = setTimeout(load, intervalMs);
    };
    timer = setTimeout(load, nonce === 0 && initial !== null ? intervalMs : 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `initial` only seeds the first render, and `merge` is read at response time: re-polling must not restart when either changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, refresh };
}
