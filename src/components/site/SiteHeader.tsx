import Link from "next/link";
import { LogoLockup } from "./Logo";

const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/#api", label: "API" },
];

/** Site header with the founders' logo. `overlay` floats it over a full-bleed hero (the landing globe). */
export function SiteHeader({ overlay = false }: { overlay?: boolean }) {
  return (
    <header className={`${overlay ? "absolute inset-x-0 top-0 z-30" : ""} mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-4 py-4 sm:px-6 sm:py-5`}>
      <Link href="/" aria-label="Terragent home" className="text-fg">
        <LogoLockup className="h-7 sm:h-8" label="" />
      </Link>
      <nav aria-label="Main" className="flex items-center gap-5 text-sm text-fg-2">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} className={`hover:text-fg ${n.href === "/#api" ? "hidden sm:inline" : ""}`}>
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
