/** The dashboard's top bar: the wordmark, and under it the switch between the Operations and Signal Engine tabs. */
import Link from "next/link";
import { Wordmark } from "../site/Wordmark";

const TABS = [
  { key: "operations", label: "Operations", href: "/dashboard" },
  { key: "signals", label: "Signal Engine", href: "/dashboard/signals" },
] as const;

export type DashboardTab = (typeof TABS)[number]["key"];

export function DashboardHeader({ current }: { current: DashboardTab }) {
  return (
    <header className="flex flex-col items-start gap-2.5 px-4 pt-3">
      <Wordmark />
      <nav aria-label="Dashboard" className="flex items-center gap-1 rounded-full border border-line-strong p-0.5 text-xs">
        {TABS.map((t) =>
          t.key === current ? (
            <span key={t.key} aria-current="page" className="rounded-full bg-raised px-3 py-1 text-fg">{t.label}</span>
          ) : (
            <Link key={t.key} href={t.href} className="rounded-full px-3 py-1 text-fg-2 transition-colors hover:text-fg">{t.label}</Link>
          ),
        )}
      </nav>
    </header>
  );
}
