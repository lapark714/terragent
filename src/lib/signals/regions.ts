/**
 * Areas the signal engine watches when the caller gives no bbox. Forest regions are 1°×1° boxes over
 * commodity-driven deforestation fronts (the size verified against the GFW API; all inside its 30°N-30°S
 * coverage), chosen for the importers the deforestation playbook sells to.
 */
import type { BBox } from "../domain";

export interface WatchRegion {
  id: string;
  label: string;
  commodity: string;
  bbox: BBox;
}

export const FOREST_WATCH_REGIONS: readonly WatchRegion[] = [
  { id: "br-rondonia", label: "Rondônia, Brazil", commodity: "cattle, soy", bbox: [-63, -10, -62, -9] },
  { id: "br-para-xingu", label: "São Félix do Xingu, Pará, Brazil", commodity: "cattle", bbox: [-52.5, -7, -51.5, -6] },
  { id: "br-mato-grosso", label: "Northern Mato Grosso, Brazil", commodity: "soy, cattle", bbox: [-56, -11, -55, -10] },
  { id: "py-chaco", label: "Paraguayan Chaco", commodity: "cattle", bbox: [-61, -22, -60, -21] },
  { id: "id-riau", label: "Riau, Sumatra, Indonesia", commodity: "palm oil, pulp", bbox: [101, 0, 102, 1] },
  { id: "id-west-kalimantan", label: "West Kalimantan, Indonesia", commodity: "palm oil", bbox: [110.5, -1, 111.5, 0] },
  { id: "ci-west", label: "Western Côte d'Ivoire", commodity: "cocoa", bbox: [-7.5, 5.5, -6.5, 6.5] },
  { id: "gh-western", label: "Western Region, Ghana", commodity: "cocoa", bbox: [-3, 5.5, -2, 6.5] },
];

/** US fire areas for the disasters playbook (FIRMS: west,south,east,north). Edges include some of Canada/Mexico. */
export const US_FIRE_AREAS: readonly WatchRegion[] = [
  { id: "us-conus", label: "Contiguous US", commodity: "", bbox: [-125, 24, -66, 50] },
  { id: "us-alaska", label: "Alaska", commodity: "", bbox: [-170, 51, -129, 72] },
  { id: "us-hawaii", label: "Hawaii", commodity: "", bbox: [-161, 18, -154, 23] },
];

export const customRegion = (bbox: BBox): WatchRegion => ({ id: "custom", label: `bbox ${bbox.join(",")}`, commodity: "", bbox });
