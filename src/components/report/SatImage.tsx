"use client";
/**
 * A satellite image that never shows as an empty box: a labelled placeholder while it loads,
 * and a plain explanation (with the source link) if the file can't be fetched.
 */
import { useState } from "react";

export function SatImage({ src, alt, label, sourceUrl, className = "" }: {
  src: string;
  alt: string;
  /** Short role label shown on the placeholder, e.g. "Before". */
  label: string;
  sourceUrl?: string | null;
  className?: string;
}) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");

  return (
    <div className={`relative aspect-square w-full overflow-hidden bg-raised ${className}`}>
      {state !== "loaded" && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <svg viewBox="0 0 32 32" className={`size-8 ${state === "loading" ? "animate-pulse motion-reduce:animate-none" : ""}`} aria-hidden>
            <path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75z" fill="none" className="stroke-line-strong" strokeWidth="2" strokeLinejoin="round" />
          </svg>
          {state === "loading" ? (
            <span className="text-sm text-fg-3">Loading {label.toLowerCase()} image…</span>
          ) : (
            <span className="flex max-w-[16rem] flex-col gap-1.5 text-sm">
              <span className="text-fg-2">The {label.toLowerCase()} image couldn&apos;t be loaded right now.</span>
              {sourceUrl ? (
                <a href={sourceUrl} rel="noreferrer" className="text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg">
                  View the source scene
                </a>
              ) : (
                <span className="text-fg-3">The measurements below don&apos;t depend on it.</span>
              )}
            </span>
          )}
        </div>
      )}
      {state !== "failed" && (
        // eslint-disable-next-line @next/next/no-img-element -- short-lived proxied file links; not worth optimising
        <img
          src={src}
          alt={alt}
          loading="lazy"
          // A cached image can finish before hydration, so onLoad never fires: check on mount too.
          ref={(img) => {
            if (img?.complete) setState(img.naturalWidth > 0 ? "loaded" : "failed");
          }}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
          className={`size-full object-cover transition-opacity duration-300 ${state === "loaded" ? "opacity-100" : "opacity-0"}`}
        />
      )}
    </div>
  );
}
