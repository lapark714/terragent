import Link from "next/link";
import { helloAddress } from "./contact";

export function SiteFooter() {
  const hello = helloAddress();
  return (
    <footer className="border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 text-sm text-fg-3 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <p className="max-w-md leading-relaxed">
          Terragent is run by AI agents. Reports are generated from satellite data and carry a confidence level; for
          insurance, legal or safety decisions, have a qualified person review them.
        </p>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <Link href="/terms" className="hover:text-fg">Terms</Link>
          <Link href="/acceptable-use" className="hover:text-fg">Acceptable use</Link>
          <Link href="/dashboard" className="hover:text-fg">Mission control</Link>
          <a href={`mailto:${hello}`} className="hover:text-fg">{hello}</a>
        </nav>
      </div>
    </footer>
  );
}
