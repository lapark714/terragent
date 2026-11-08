/**
 * Reads coordinates however people paste them:
 *   "20.874, -156.678"   "20.874 -156.678"   "20.874N 156.678W"   "N 20.874 W 156.678"
 *   20°52'26"N 156°40'40"W   (also with ′ ″ or spaces)
 *   Google / Apple / OSM map links containing "@lat,lng", "q=lat,lng", "ll=lat,lng" or "#map=z/lat/lng".
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const valid = (lat: number, lng: number): LatLng | null =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;

/** One axis in decimal or degrees-minutes-seconds, with an optional hemisphere letter before or after. */
const AXIS = String.raw`([NSEW])?\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:°|º|d|\s)?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:'|′|m|\s)\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*(?:"|″|''|s)\s*)?([NSEW])?`;
const PAIR = new RegExp(String.raw`^\s*${AXIS}\s*[,;/\s]\s*${AXIS}\s*$`, "i");

function axis(deg: string, min?: string, sec?: string, h1?: string, h2?: string): { v: number; h: string | null } {
  let v = Math.abs(Number(deg)) + (min ? Number(min) / 60 : 0) + (sec ? Number(sec) / 3600 : 0);
  const h = (h1 ?? h2 ?? "").toUpperCase() || null;
  if (deg.startsWith("-") || h === "S" || h === "W") v = -v;
  return { v, h };
}

function fromLink(text: string): LatLng | null {
  const t = text.trim();
  if (!/^https?:\/\//i.test(t) && !t.includes("@") && !t.includes("map=")) return null;
  const num = String.raw`(-?\d{1,3}(?:\.\d+)?)`;
  const patterns = [
    new RegExp(String.raw`@${num},${num}`),
    new RegExp(String.raw`[?&](?:q|ll|query|center|destination)=${num}(?:,|%2C)\s*${num}`, "i"),
    new RegExp(String.raw`[#&]map=\d+(?:\.\d+)?/${num}/${num}`),
    new RegExp(String.raw`!3d${num}!4d${num}`),
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return valid(Number(m[1]), Number(m[2]));
  }
  return null;
}

export function parseCoords(text: string): LatLng | null {
  if (!text) return null;
  const link = fromLink(text);
  if (link) return link;
  const m = text.trim().match(PAIR);
  if (!m) return null;
  const a = axis(m[2], m[3], m[4], m[1], m[5]);
  const b = axis(m[7], m[8], m[9], m[6], m[10]);
  // Hemisphere letters can put longitude first ("156.6W 20.8N").
  if ((a.h === "E" || a.h === "W") && (b.h === "N" || b.h === "S" || b.h === null)) return valid(b.v, a.v);
  return valid(a.v, b.v);
}

/** "20.87388, -156.67768": the exact form the server's parseLatLon reads as coordinates. */
export const formatCoords = ({ lat, lng }: LatLng, digits = 5) => `${lat.toFixed(digits)}, ${lng.toFixed(digits)}`;

/** Human form for display: 20.874° N, 156.678° W */
export function prettyCoords({ lat, lng }: LatLng): string {
  return `${Math.abs(lat).toFixed(3)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(3)}° ${lng >= 0 ? "E" : "W"}`;
}
