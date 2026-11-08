/**
 * Turns what someone typed (or tapped) into a place on the globe. Three layers, fastest first:
 *   1. coordinates and map links, parsed locally;
 *   2. the built-in gazetteer, instant and offline;
 *   3. Photon (photon.komoot.io), a free, keyless OpenStreetMap search that finds street addresses,
 *      landmarks and small towns. Debounced by the caller, aborted on each keystroke, short timeout.
 * Failure of layer 3 is never fatal: the typed text is still a valid location for the request.
 */
import { formatCoords, parseCoords, prettyCoords, type LatLng } from "./coords";
import { searchPlaces } from "./places";

export type PlaceKind = "coords" | "pin" | "address" | "place" | "region";

export interface Place extends LatLng {
  /** Main line, e.g. "Front Street" or "Lahaina". */
  label: string;
  /** Second line, e.g. "Lahaina, Hawaii, United States". */
  detail: string;
  kind: PlaceKind;
  /** How close the camera should fly (globe radii above the surface). */
  altitude: number;
}

const PHOTON = "https://photon.komoot.io";
const TIMEOUT_MS = 3500;

/** Camera altitude per kind of place: streets come in close, countries stay wide. */
export const ALTITUDE: Record<PlaceKind, number> = { coords: 0.06, pin: 0.06, address: 0.04, place: 0.12, region: 0.6 };

/** What goes in the request's location field: the server reads pure "lat, lon" as coordinates. */
export function placeToLocation(p: Place): string {
  if (p.kind === "coords" || p.kind === "pin") return formatCoords(p);
  const name = [p.label, p.detail].filter(Boolean).join(", ");
  return `${name} · ${formatCoords(p)}`;
}

export function coordsPlace(c: LatLng, kind: "coords" | "pin" = "coords"): Place {
  return { ...c, label: prettyCoords(c), detail: kind === "pin" ? "Dropped pin" : "Coordinates", kind, altitude: ALTITUDE[kind] };
}

export function localPlaces(query: string): Place[] {
  return searchPlaces(query).map((p) => ({ lat: p.lat, lng: p.lng, label: p.name, detail: p.region, kind: "place", altitude: ALTITUDE.place }));
}

interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    name?: string; street?: string; housenumber?: string; city?: string; district?: string; county?: string;
    state?: string; country?: string; osm_key?: string; osm_value?: string; type?: string;
    extent?: [number, number, number, number];
  };
}

function fromPhoton(f: PhotonFeature): Place {
  const p = f.properties;
  const [lng, lat] = f.geometry.coordinates;
  const street = p.street ? [p.housenumber, p.street].filter(Boolean).join(" ") : null;
  const label = p.name ?? street ?? p.city ?? p.state ?? p.country ?? "Unnamed place";
  const detail = [p.name && street && street !== p.name ? street : null, p.city !== label ? p.city : null, p.state, p.country]
    .filter((x): x is string => !!x && x !== label)
    .filter((x, i, a) => a.indexOf(x) === i)
    .join(", ");
  const kind: PlaceKind =
    p.type === "country" || p.type === "state" ? "region"
      : p.type === "house" || p.type === "street" || p.housenumber ? "address"
        : "place";
  // Size the zoom to the feature's extent when we have one: a big park or county shouldn't be a street view.
  let altitude = ALTITUDE[kind];
  if (p.extent) {
    const [w, n, e, s] = p.extent;
    const span = Math.max(Math.abs(e - w), Math.abs(n - s));
    altitude = Math.min(1.2, Math.max(0.03, span / 40));
  }
  return { lat, lng, label, detail, kind, altitude };
}

/** The caller's signal plus a timeout. AbortSignal.any is Safari 17.4+, so combine by hand. */
function withTimeout(signal: AbortSignal, ms: number): { signal: AbortSignal; done: () => void } {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  if (signal.aborted) ctrl.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, ms);
  return { signal: ctrl.signal, done: () => (clearTimeout(timer), signal.removeEventListener("abort", abort)) };
}

async function photon(path: string, outer: AbortSignal): Promise<Place[]> {
  const { signal, done } = withTimeout(outer, TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${PHOTON}${path}`, { signal });
  } finally {
    done();
  }
  if (!res.ok) throw new Error(`Place search answered ${res.status}`);
  const body = (await res.json()) as { features?: PhotonFeature[] };
  return (body.features ?? []).map(fromPhoton);
}

/** Address / landmark search. Throws on network failure; callers fall back to local results. */
export function searchRemote(query: string, signal: AbortSignal, near?: LatLng): Promise<Place[]> {
  const bias = near ? `&lat=${near.lat.toFixed(2)}&lon=${near.lng.toFixed(2)}` : "";
  return photon(`/api/?q=${encodeURIComponent(query.trim())}&limit=5&lang=en${bias}`, signal);
}

/** Name for a dropped pin. Falls back to the coordinates if the lookup fails. */
export async function reverse(c: LatLng, signal: AbortSignal): Promise<Place> {
  const pin = coordsPlace(c, "pin");
  try {
    const [hit] = await photon(`/reverse?lat=${c.lat}&lon=${c.lng}&limit=1&lang=en`, signal);
    if (!hit) return pin;
    // Keep the exact tapped point; borrow only the name.
    return { ...pin, detail: [hit.label, hit.detail].filter(Boolean).join(", ") };
  } catch {
    return pin;
  }
}

/** Synchronous first pass for each keystroke: coordinates beat everything, then the gazetteer. */
export function instant(query: string): { coords: Place | null; places: Place[] } {
  const c = parseCoords(query);
  return { coords: c ? coordsPlace(c) : null, places: c ? [] : localPlaces(query) };
}

/** Merge local and remote results, dropping near-duplicates (same name within ~5 km). */
export function mergePlaces(a: Place[], b: Place[], limit = 6): Place[] {
  const out: Place[] = [];
  for (const p of [...a, ...b]) {
    const dup = out.some((q) => q.label.toLowerCase() === p.label.toLowerCase() && Math.abs(q.lat - p.lat) < 0.05 && Math.abs(q.lng - p.lng) < 0.05);
    if (!dup) out.push(p);
  }
  return out.slice(0, limit);
}
