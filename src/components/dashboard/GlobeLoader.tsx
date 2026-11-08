"use client";
/** Client-only boundary for the WebGL globe (ssr:false must live in a client file). */
import dynamic from "next/dynamic";

export const GlobeLoader = dynamic(() => import("./EarthGlobe"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 grid place-items-center text-sm text-fg-3">Loading the globe…</div>,
});
