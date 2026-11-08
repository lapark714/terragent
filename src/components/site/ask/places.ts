/**
 * A small built-in gazetteer: instant suggestions while the address search is in flight, and a fallback
 * when it's unreachable (offline demo, flaky wifi). [name, region, lat, lng]. Approximate centres.
 */
export const PLACES: readonly [string, string, number, number][] = [
  // The places in our examples and demo reports first.
  ["Lahaina", "Maui, Hawaii, US", 20.874, -156.678],
  ["Port Arthur", "Texas, US", 29.885, -93.94],
  ["Westland", "South Holland, Netherlands", 52.0, 4.22],
  ["Carneros", "Sonoma County, California, US", 38.255, -122.4],
  ["Aberdeenshire", "Scotland, UK", 57.28, -2.58],
  ["Rondônia", "Brazil", -10.9, -62.8],
  ["Porto Velho", "Rondônia, Brazil", -8.761, -63.9],
  ["Paradise", "California, US", 39.76, -121.62],
  ["Valencia", "Spain", 39.47, -0.376],
  ["Derna", "Libya", 32.767, 22.64],
  // Major cities.
  ["New York", "New York, US", 40.713, -74.006],
  ["Los Angeles", "California, US", 34.052, -118.244],
  ["San Francisco", "California, US", 37.775, -122.419],
  ["Houston", "Texas, US", 29.76, -95.37],
  ["Miami", "Florida, US", 25.762, -80.192],
  ["New Orleans", "Louisiana, US", 29.951, -90.072],
  ["Chicago", "Illinois, US", 41.878, -87.63],
  ["Denver", "Colorado, US", 39.739, -104.99],
  ["Phoenix", "Arizona, US", 33.448, -112.074],
  ["Seattle", "Washington, US", 47.606, -122.332],
  ["Honolulu", "Hawaii, US", 21.307, -157.858],
  ["Anchorage", "Alaska, US", 61.218, -149.9],
  ["Toronto", "Ontario, Canada", 43.653, -79.383],
  ["Vancouver", "British Columbia, Canada", 49.283, -123.121],
  ["Mexico City", "Mexico", 19.433, -99.133],
  ["Bogotá", "Colombia", 4.711, -74.072],
  ["Lima", "Peru", -12.046, -77.043],
  ["Manaus", "Amazonas, Brazil", -3.119, -60.022],
  ["São Paulo", "Brazil", -23.551, -46.633],
  ["Rio de Janeiro", "Brazil", -22.907, -43.173],
  ["Santiago", "Chile", -33.449, -70.669],
  ["Buenos Aires", "Argentina", -34.604, -58.382],
  ["London", "England, UK", 51.507, -0.128],
  ["Leeds", "England, UK", 53.801, -1.549],
  ["Edinburgh", "Scotland, UK", 55.953, -3.188],
  ["Dublin", "Ireland", 53.35, -6.26],
  ["Paris", "France", 48.857, 2.352],
  ["Amsterdam", "Netherlands", 52.368, 4.904],
  ["Rotterdam", "Netherlands", 51.924, 4.478],
  ["Berlin", "Germany", 52.52, 13.405],
  ["Madrid", "Spain", 40.417, -3.704],
  ["Lisbon", "Portugal", 38.722, -9.139],
  ["Rome", "Italy", 41.903, 12.496],
  ["Athens", "Greece", 37.984, 23.728],
  ["Istanbul", "Türkiye", 41.008, 28.978],
  ["Kyiv", "Ukraine", 50.45, 30.523],
  ["Stockholm", "Sweden", 59.329, 18.069],
  ["Cairo", "Egypt", 30.044, 31.236],
  ["Lagos", "Nigeria", 6.524, 3.379],
  ["Nairobi", "Kenya", -1.286, 36.817],
  ["Kinshasa", "DR Congo", -4.441, 15.266],
  ["Johannesburg", "South Africa", -26.204, 28.047],
  ["Cape Town", "South Africa", -33.925, 18.424],
  ["Dubai", "United Arab Emirates", 25.205, 55.271],
  ["Riyadh", "Saudi Arabia", 24.713, 46.675],
  ["Karachi", "Pakistan", 24.861, 67.01],
  ["Delhi", "India", 28.704, 77.102],
  ["Mumbai", "India", 19.076, 72.878],
  ["Dhaka", "Bangladesh", 23.81, 90.413],
  ["Bangkok", "Thailand", 13.756, 100.502],
  ["Jakarta", "Indonesia", -6.208, 106.846],
  ["Pekanbaru", "Riau, Indonesia", 0.507, 101.448],
  ["Kuala Lumpur", "Malaysia", 3.139, 101.687],
  ["Singapore", "Singapore", 1.352, 103.82],
  ["Manila", "Philippines", 14.599, 120.984],
  ["Ho Chi Minh City", "Vietnam", 10.823, 106.63],
  ["Hong Kong", "China", 22.32, 114.17],
  ["Shanghai", "China", 31.23, 121.474],
  ["Beijing", "China", 39.904, 116.407],
  ["Seoul", "South Korea", 37.567, 126.978],
  ["Tokyo", "Japan", 35.676, 139.65],
  ["Sydney", "New South Wales, Australia", -33.869, 151.209],
  ["Melbourne", "Victoria, Australia", -37.814, 144.963],
  ["Perth", "Western Australia", -31.95, 115.86],
  ["Auckland", "New Zealand", -36.849, 174.763],
  ["Reykjavík", "Iceland", 64.147, -21.942],
];

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Prefix match on the name first, then anywhere in name or region. */
export function searchPlaces(query: string, limit = 5) {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const scored = PLACES.flatMap(([name, region, lat, lng]) => {
    const n = fold(name);
    const full = `${n}, ${fold(region)}`;
    const score = n.startsWith(q) ? 0 : full.startsWith(q) ? 1 : full.includes(q) ? 2 : -1;
    return score < 0 ? [] : [{ score, name, region, lat, lng }];
  });
  return scored.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name)).slice(0, limit);
}
