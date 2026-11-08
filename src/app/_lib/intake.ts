/** Input schemas for the portal form and the public API, mapped onto the shared NewRequestInput contract. */
import { z } from "zod";
import { NewRequestInput } from "@/lib/domain";

/** Empty form fields arrive as "" — treat them as missing. */
const optionalText = (max: number) =>
  z.preprocess((v) => (typeof v === "string" ? v.trim() || undefined : v), z.string().max(max).optional());

/** "37.77, -122.42" typed into the place field becomes coordinates as well. */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

export const PortalForm = z.object({
  location: z.string().trim().min(2, "Tell us the place: an address, a town, an area or coordinates.").max(500),
  question: z.string().trim().min(5, "Ask your question in a few words or more.").max(2000),
  email: z.string().trim().pipe(z.email("Enter the email address where the answer should go.")),
  name: optionalText(200),
  company: optionalText(200),
  /** Honeypot: hidden from people, filled in by bots. */
  website: optionalText(500),
});
export type PortalForm = z.infer<typeof PortalForm>;

export function portalToRequest(f: PortalForm): NewRequestInput {
  return NewRequestInput.parse({
    question: f.question,
    location_text: f.location,
    ...parseLatLon(f.location),
    email: f.email,
    name: f.name,
    company: f.company,
  });
}

export const AnswerBody = z
  .strictObject({
    question: z.string().trim().min(5).max(2000),
    location: z.string().trim().min(2).max(500).optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    email: z.email().optional(),
    callback_url: z.url({ protocol: /^https$/, error: "callback_url must be an https URL" }).max(2000).optional(),
  })
  .refine((b) => (b.lat === undefined) === (b.lon === undefined), { message: "Send lat and lon together", path: ["lon"] })
  .refine((b) => b.location !== undefined || b.lat !== undefined, { message: "Send a location or lat/lon", path: ["location"] });
export type AnswerBody = z.infer<typeof AnswerBody>;

export function answerToRequest(b: AnswerBody): NewRequestInput {
  return NewRequestInput.parse({
    question: b.question,
    location_text: b.location,
    ...(b.lat !== undefined ? { lat: b.lat, lon: b.lon } : b.location ? parseLatLon(b.location) : null),
    email: b.email,
  });
}

export function issues(err: z.ZodError) {
  return err.issues.map((i) => ({ field: i.path.join(".") || null, message: i.message }));
}
