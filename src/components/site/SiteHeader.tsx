import { Wordmark } from "./Wordmark";
import { helloAddress } from "./contact";

const NAV = [
  { href: "/#how", label: "How it works" },
  { href: "/#api", label: "API" },
  { href: "/dashboard", label: "Mission control" },
];

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-6 px-4 py-5 sm:px-6">
      <Wordmark />
      <nav aria-label="Main" className="flex items-center gap-4 text-sm text-fg-2 sm:gap-5">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className="hidden hover:text-fg sm:inline">
            {n.label}
          </a>
        ))}
        <a href="/dashboard" className="whitespace-nowrap hover:text-fg sm:hidden">
          Mission control
        </a>
        <a href={`mailto:${helloAddress()}`} className="rounded-md border border-line-strong px-3 py-1.5 whitespace-nowrap text-fg hover:border-fg-3">
          Email us
        </a>
      </nav>
    </header>
  );
}
