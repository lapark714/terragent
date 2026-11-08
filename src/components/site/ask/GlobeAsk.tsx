"use client";
/**
 * The landing hero: a spinning globe and one question, "Where on Earth?". Type an address, a place,
 * coordinates or a map link, or tap the globe to drop a pin. The camera flies down to the spot, swaps to
 * real Sentinel-2 imagery, and the details sheet asks the rest.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import type { LatLng } from "./coords";
import { AskSheet } from "./AskSheet";
import { coordsPlace, reverse, type Place } from "./geocode";
import type { GlobeTarget } from "./HeroGlobe";
import { GlobeStill, HeroGlobeLoader } from "./HeroGlobeLoader";
import { PlaceSearch } from "./PlaceSearch";
import { SITE } from "@/lib/demo/yc";

const EXAMPLES: { text: string; place: Place }[] = [
  { text: "Lahaina, Maui", place: { lat: 20.874, lng: -156.678, label: "Lahaina", detail: "Maui, Hawaii, United States", kind: "place", altitude: 0.08 } },
  { text: "Rondônia farmland", place: { lat: -9.97, lng: -63.03, label: "9.970° S, 63.030° W", detail: "Rondônia, Brazil", kind: "coords", altitude: 0.08 } },
  { text: "Port Arthur, Texas", place: { lat: 29.885, lng: -93.94, label: "Port Arthur", detail: "Texas, United States", kind: "place", altitude: 0.1 } },
];

/** /demo only: YC's Dogpatch office (OpenStreetMap position) leads the chips. */
const DEMO_EXAMPLES: { text: string; place: Place }[] = [
  { text: `YC, ${SITE.short}`, place: { lat: SITE.lat, lng: SITE.lng, label: SITE.name, detail: SITE.detail, kind: "address", altitude: 0.04 } },
  ...EXAMPLES.slice(0, 2),
];

const noSubscribe = () => () => {};

let webglCache: boolean | null = null;
function hasWebGL(): boolean {
  if (webglCache !== null) return webglCache;
  try {
    const c = document.createElement("canvas");
    return (webglCache = !!(c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return (webglCache = false);
  }
}

/** `demo` (the /demo page): YC example chips, and the ask sheet plays a scripted run instead of posting a request. */
export function GlobeAsk({ hello, demo = false }: { hello: string; demo?: boolean }) {
  const [phase, setPhase] = useState<"where" | "details">("where");
  const [place, setPlace] = useState<Place | null>(null);
  const [placeText, setPlaceText] = useState("");
  const [target, setTarget] = useState<GlobeTarget | null>(null);
  const [tilesOn, setTilesOn] = useState(false);
  const webgl = useSyncExternalStore(noSubscribe, hasWebGL, () => null);
  const [liveReady, setLiveReady] = useState(false);
  const markReady = useCallback(() => setLiveReady(true), []);
  const seq = useRef(0);
  const pinLookup = useRef<AbortController | null>(null);

  const goTo = useCallback((p: Place) => {
    setPlace(p);
    setPlaceText([p.label, p.detail].filter(Boolean).join(", "));
    setTarget({ lat: p.lat, lng: p.lng, altitude: p.altitude, key: `${++seq.current}` });
    setTilesOn(true);
    setPhase("details");
  }, []);

  const onFreeText = useCallback((text: string) => {
    setPlace(null);
    setPlaceText(text);
    setTarget(null);
    setPhase("details");
  }, []);

  /** Tap-to-pin: fly there right away with the coordinates; fill in the place name when the lookup returns. */
  const onPick = useCallback((c: LatLng) => {
    const pin = coordsPlace(c, "pin");
    goTo(pin);
    pinLookup.current?.abort();
    const ctrl = new AbortController();
    pinLookup.current = ctrl;
    reverse(c, ctrl.signal).then((named) => {
      if (!ctrl.signal.aborted) setPlace((cur) => (cur && cur.lat === c.lat && cur.lng === c.lng ? named : cur));
    });
  }, [goTo]);

  const back = useCallback(() => {
    pinLookup.current?.abort();
    setPhase("where");
    setTarget(null);
    setTilesOn(false);
  }, []);

  const details = phase === "details";

  return (
    <section aria-label="Ask about a place" className="relative isolate h-[100svh] min-h-[600px] overflow-hidden bg-space">
      {/* Starfield-free deep gradient so the globe reads as lit from the sun side. */}
      <div aria-hidden className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_at_50%_40%,#12243a_0%,#0a1523_55%,#060e18_100%)]" />

      {/* Globe: full-bleed while choosing; top band on phones / left area on desktop once the sheet is up. */}
      <div
        className={`absolute inset-x-0 top-0 transition-[height,right] duration-700 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none ${
          details ? "h-[40svh] sm:h-full sm:right-[min(30rem,42vw)]" : "h-[60svh] right-0 sm:h-full lg:left-[36%]"
        }`}
      >
        {/* Still image underneath; the WebGL globe fades in over it when ready (or never, without WebGL). */}
        <div className={`transition-opacity duration-1000 ${liveReady || target ? "opacity-0" : "opacity-100"}`}>
          <GlobeStill />
        </div>
        {webgl && <HeroGlobeLoader target={target} onPick={onPick} onReady={markReady} />}
      </div>

      {/* Step 1: where */}
      <div
        className={`pointer-events-none absolute inset-0 flex flex-col items-center justify-end px-4 pb-[max(2rem,env(safe-area-inset-bottom))] transition-opacity duration-300 sm:justify-center sm:pb-0 lg:items-start lg:pl-[max(2rem,calc((100vw-72rem)/2+1.5rem))] ${
          details ? "opacity-0" : "opacity-100"
        }`}
        aria-hidden={details}
      >
        <div className={`flex w-full max-w-xl flex-col items-center gap-5 text-center lg:max-w-[34rem] lg:items-start lg:text-left ${details ? "" : "pointer-events-auto"}`}>
          <h1 className="stretch-wide text-[clamp(2.4rem,7vw,4.5rem)] leading-[0.95] font-semibold tracking-[-0.03em] text-balance drop-shadow-[0_4px_24px_rgba(0,0,0,0.6)]">
            Where on Earth?
          </h1>
          <p className="max-w-md text-base leading-relaxed text-fg-2 drop-shadow-[0_2px_12px_rgba(0,0,0,0.8)] sm:text-lg">
            Pick any place and ask about it. AI agents read the satellite imagery and send you a verified report.
          </p>
          {!details && <PlaceSearch onChoose={goTo} onFreeText={onFreeText} autoFocus />}
          <div className="flex flex-col items-center gap-3 lg:items-start">
            <p className="flex items-center gap-2 text-sm text-fg-3">
              <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
                <path d="M8 14s5-4.6 5-8.2A5 5 0 0 0 3 5.8C3 9.4 8 14 8 14Z" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
              Or tap the globe to drop a pin
            </p>
            <div className="flex flex-wrap justify-center gap-2 lg:justify-start">
              {(demo ? DEMO_EXAMPLES : EXAMPLES).map((ex) => (
                <button key={ex.text} type="button" onClick={() => goTo(ex.place)} tabIndex={details ? -1 : 0}
                  className="rounded-full border border-line-strong bg-space/60 px-3 py-1.5 text-sm text-fg-2 backdrop-blur-sm transition-colors hover:border-fg-3 hover:text-fg">
                  {ex.text}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Step 2: details sheet */}
      {details && (
        <div className="pointer-events-none absolute inset-x-0 top-[calc(40svh-1.25rem)] bottom-0 z-20 flex justify-center sm:top-0 sm:right-6 sm:left-auto sm:w-[min(28rem,40vw)] sm:items-center">
          <AskSheet key={place ? `${place.lat},${place.lng}` : placeText} place={place} placeText={placeText} hello={hello} onBack={back} demo={demo} />
        </div>
      )}

      {/* Imagery credit (required by the CC BY licence) while the satellite tiles are showing. */}
      {tilesOn && (
        <p className={`absolute left-3 z-10 text-[10px] text-fg-3/80 ${details ? "top-[calc(40svh-2.75rem)] sm:top-auto sm:bottom-3" : "bottom-3"}`}>
          <a href="https://s2maps.eu" rel="noreferrer" className="hover:text-fg">Sentinel-2 cloudless 2016 © EOX, CC BY 4.0</a>
        </p>
      )}
    </section>
  );
}
