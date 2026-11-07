/** OWNER: email builder. Opt-out tokens (never the address in the URL) and the suppression list. */
export async function optOutUrl(email: string): Promise<string> { throw new Error("not implemented yet"); }
export async function isSuppressed(email: string): Promise<boolean> { throw new Error("not implemented yet"); }
export async function suppress(email: string, reason: "opt_out" | "bounce" | "complaint" | "manual"): Promise<void> { throw new Error("not implemented yet"); }
