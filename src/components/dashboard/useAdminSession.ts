"use client";
/** Founder name + admin token, kept for this browser tab only (sessionStorage). */
import { useMemo, useSyncExternalStore } from "react";

export interface AdminSession { actor: string; token: string }

const KEY = "terragent.admin";
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAdminSession() {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const session = useMemo<AdminSession | null>(() => {
    try {
      return raw ? (JSON.parse(raw) as AdminSession) : null;
    } catch {
      return null;
    }
  }, [raw]);

  const save = (next: AdminSession | null) => {
    try {
      if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
      else sessionStorage.removeItem(KEY);
    } catch {
      // Storage blocked: the session simply won't persist.
    }
    listeners.forEach((l) => l());
  };

  return { session, save };
}
