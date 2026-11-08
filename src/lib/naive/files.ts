/** Naïve Files: keyless 7-day URLs for report images. */
import { isOffline } from "../env";
import { getNaive, NaiveOfflineError } from "./client";

/** Re-mint a link once it has less than this left, so an emailed link stays valid for days. */
const MIN_REMAINING_MS = 24 * 3600 * 1000;
const urls = new Map<string, { url: string; expiresAt: number }>();

export async function fileUrl(fileId: string): Promise<string> {
  if (isOffline()) throw new NaiveOfflineError();
  const cached = urls.get(fileId);
  if (cached && cached.expiresAt - Date.now() > MIN_REMAINING_MS) return cached.url;
  const naive = await getNaive();
  const minted = await naive.files.url(fileId);
  urls.set(fileId, { url: minted.url, expiresAt: Date.parse(minted.expires_at) });
  return minted.url;
}

/** Raw bytes (downloadBytes; `download` would mangle binary) plus the stored content type. */
export async function fileBytes(fileId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (isOffline()) throw new NaiveOfflineError();
  const naive = await getNaive();
  const [bytes, meta] = await Promise.all([naive.files.downloadBytes(fileId), naive.files.get(fileId)]);
  return { bytes, contentType: meta.content_type };
}
