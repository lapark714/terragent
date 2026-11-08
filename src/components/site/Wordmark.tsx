import Link from "next/link";

/** The H3 hexagon (our Earth index cell) and the name, set wide. */
export function Wordmark({ href = "/", suffix }: { href?: string; suffix?: string }) {
  return (
    <Link href={href} className="group inline-flex items-center gap-2.5 text-fg">
      <svg viewBox="0 0 32 32" className="size-6 shrink-0" aria-hidden>
        <path d="M16 3.5 26.8 9.75v12.5L16 28.5 5.2 22.25V9.75z" fill="none" className="stroke-inbound" strokeWidth="2.6" strokeLinejoin="round" />
        <circle cx="16" cy="16" r="3.6" className="fill-fg" />
      </svg>
      <span className="stretch-wide text-[1.05rem] font-semibold tracking-[-0.01em]">Terragent</span>
      {suffix && <span className="hidden text-sm text-fg-3 sm:inline">{suffix}</span>}
    </Link>
  );
}
