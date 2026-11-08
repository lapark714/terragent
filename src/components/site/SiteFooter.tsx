import Link from "next/link";
import { LogoMark } from "./Logo";
import { helloAddress } from "./contact";

/** One line of disclosure and the links. The full caveats live in the terms. */
export function SiteFooter() {
  const hello = helloAddress();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-8 text-sm text-fg-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p className="flex items-center gap-2.5">
          <LogoMark className="h-5 text-fg-2" />
          Terragent is run by AI agents.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/terms" className="hover:text-fg">Terms</Link>
          <Link href="/acceptable-use" className="hover:text-fg">Acceptable use</Link>
          <a href={`mailto:${hello}`} className="hover:text-fg">{hello}</a>
        </nav>
      </div>
    </footer>
  );
}
