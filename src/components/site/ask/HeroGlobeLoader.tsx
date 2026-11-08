"use client";
/** Client-only boundary for the landing globe. Until WebGL is up, a still of the night Earth holds its place. */
import dynamic from "next/dynamic";

/** The live globe fades in over the still once its texture is ready, so there's never an empty screen. */
export const HeroGlobeLoader = dynamic(() => import("./HeroGlobe"), { ssr: false, loading: () => null });

/** CSS-only stand-in (loading, or no WebGL): same texture and framing as the live globe's idle view. */
export function GlobeStill() {
  return (
    <div className="absolute inset-0 grid place-items-center" aria-hidden>
      <div
        className="aspect-square w-[min(88vw,72vh)] rounded-full bg-[length:200%_100%] opacity-90 shadow-[0_0_80px_10px_rgba(93,127,216,0.25)]"
        style={{ backgroundImage: "url(/globe/earth-night.jpg)", backgroundPosition: "30% 50%" }}
      />
    </div>
  );
}
