"use client";
/** Copy the report's share link. Falls back to selecting the URL when the clipboard API is blocked. */
import { useEffect, useRef, useState } from "react";

type State = "idle" | "copied" | "manual";

export function CopyLink({ url, className = "" }: { url?: string; className?: string }) {
  const [state, setState] = useState<State>("idle");
  const field = useRef<HTMLInputElement>(null);
  const href = url ?? (typeof window === "undefined" ? "" : window.location.href.split("#")[0]);

  useEffect(() => {
    if (state !== "copied") return;
    const t = setTimeout(() => setState("idle"), 2200);
    return () => clearTimeout(t);
  }, [state]);

  useEffect(() => {
    if (state === "manual") field.current?.select();
  }, [state]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(href || window.location.href);
      setState("copied");
    } catch {
      setState("manual");
    }
  }

  if (state === "manual") {
    return (
      <label className={`flex flex-col gap-1.5 text-sm text-fg-3 ${className}`}>
        Copy this link
        <input
          ref={field}
          readOnly
          value={href}
          onFocus={(e) => e.currentTarget.select()}
          className="w-full rounded-md border border-line-strong bg-space px-3 py-2 font-mono text-[13px] text-fg"
        />
      </label>
    );
  }

  return (
    <button
      type="button"
      onClick={copy}
      className={`inline-flex items-center justify-center gap-2 rounded-md border border-line-strong px-3.5 py-2 text-sm whitespace-nowrap text-fg transition-colors hover:border-fg-3 ${className}`}
    >
      <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden>
        {state === "copied" ? (
          <path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-forest" />
        ) : (
          <path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.83 2.83 0 0 1 4 4l-1 1M9 11.5l-1 1a2.83 2.83 0 0 1-4-4l1-1" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        )}
      </svg>
      <span aria-live="polite">{state === "copied" ? "Link copied" : "Copy link"}</span>
    </button>
  );
}
