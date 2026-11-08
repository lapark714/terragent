import Link from "next/link";
import { Wordmark } from "@/components/site/Wordmark";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center gap-6 px-4 sm:px-6">
      <Wordmark />
      <h1 className="stretch-wide text-3xl font-semibold tracking-[-0.02em]">Nothing at this address</h1>
      <p className="text-fg-2">
        The link may be mistyped, or the report isn&apos;t verified yet. Report links start working once the verifier passes them.
      </p>
      <Link href="/" className="text-fg underline underline-offset-4">Ask a question instead</Link>
    </div>
  );
}
