import Link from "next/link";
import { LogoLockup } from "./Logo";

const NAV = [
  { hash: "#how", label: "How it works" },
  { hash: "#api", label: "API" },
];

/** Site header with the founders' logo. `overlay` floats it over a full-bleed hero (the landing globe). */
export function SiteHeader({ overlay = false, home = "/" }: { overlay?: boolean; home?: string }) {
  return (
    <header className={`${overlay ? "absolute inset-x-0 top-0 z-30" : ""} mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-4 py-4 sm:px-6 sm:py-5`}>
      <Link href={home} aria-label="Terragent home" className="text-fg">
        <LogoLockup className="h-7 sm:h-8" label="" />
      </Link>
      {/* Hidden while the landing's ask sheet is open (GlobeAsk sets <html data-asking>): it would sit on the sheet. */}
      <nav aria-label="Main" className="flex items-center gap-5 text-sm text-fg-2 transition-[opacity,visibility] duration-300 in-data-asking:invisible in-data-asking:opacity-0">
        {NAV.map((n) => (
          <Link key={n.hash} href={`${home}${n.hash}`} className={`hover:text-fg ${n.hash === "#api" ? "hidden sm:inline" : ""}`}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
