/** OWNER: signals builder. Free geocoders first (US Census, Nominatim), Monid only as paid fallback. */
import type { BBox } from "../domain";

export interface GeocodeResult {
  lat: number;
  lon: number;
  display_name: string;
  geocoder: "census" | "nominatim" | "monid" | "user";
  confidence: "high" | "medium" | "low";
  bbox?: BBox;
  country_code?: string;
}

export async function geocode(text: string): Promise<GeocodeResult | null> { throw new Error("not implemented yet"); }
