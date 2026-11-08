"use server";

import { redirect } from "next/navigation";
import { unsubscribeByToken } from "@/lib/email/optout";

/** The token is the only credential: it maps to one address and can only ever unsubscribe it. */
export async function confirmUnsubscribe(formData: FormData) {
  const token = String(formData.get("t") ?? "");
  await unsubscribeByToken(token);
  redirect(`/unsubscribe?t=${encodeURIComponent(token)}&done=1`);
}
