import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";

/** Shared frame for the terms and acceptable-use pages. */
export function LegalPage({ title, updated, intro, sections }: {
  title: string;
  updated: string;
  intro: string;
  sections: { heading: string; body: React.ReactNode }[];
}) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 pt-10 pb-24 sm:px-6">
        <h1 className="stretch-wide mb-3 text-4xl font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mb-8 text-sm text-fg-3">Last updated {updated}</p>
        <p className="mb-12 text-lg leading-relaxed text-fg-2">{intro}</p>
        <div className="flex flex-col gap-10">
          {sections.map((s) => (
            <section key={s.heading}>
              <h2 className="stretch-semi mb-3 text-xl font-semibold">{s.heading}</h2>
              <div className="flex flex-col gap-3 leading-relaxed text-fg-2 [&_li]:ml-5 [&_li]:list-disc [&_ul]:flex [&_ul]:flex-col [&_ul]:gap-2">
                {s.body}
              </div>
            </section>
          ))}
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
