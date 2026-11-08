import Link from "next/link";
import { LogoLockup } from "@/components/site/Logo";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 sm:px-6">
      <Link href="/" aria-label="Terragent home" className="text-fg"><LogoLockup className="h-8" label="" /></Link>
      <h1 className="stretch-wide text-3xl font-semibold tracking-[-0.02em]">Nothing at this address</h1>
      <p className="text-fg-2">
        The link may be mistyped, or the report isn&apos;t verified yet. Report links start working once our verifier agent passes them. Terragent is run by AI agents.
      </p>
      <Link href="/" className="text-fg underline underline-offset-4">Ask a question instead</Link>
    </div>
  );
}
