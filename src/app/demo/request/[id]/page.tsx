import type { Metadata } from "next";
import { DemoRequestView } from "@/components/demo/DemoRequestView";
import { helloAddress } from "@/components/site/contact";
import { DEMO_PERIOD, DEMO_QUESTION, SITE } from "@/lib/demo/yc";

export const metadata: Metadata = { title: "Your request" };

const DEFAULT_LOCATION = `${SITE.name}, ${SITE.detail} · ${SITE.lat.toFixed(5)}, ${SITE.lng.toFixed(5)}`;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** Synthetic: any id works, nothing is read from the database. Place and question come from the demo ask form. */
export default async function DemoRequestPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const speed = Number(one(sp.speed));
  return (
    <DemoRequestView
      id={id}
      question={one(sp.q)?.slice(0, 600) || `${DEMO_QUESTION}\n\n${DEMO_PERIOD}`}
      location={one(sp.loc)?.slice(0, 200) || DEFAULT_LOCATION}
      speed={Number.isFinite(speed) && speed > 0 ? Math.min(speed, 20) : 1}
      hello={helloAddress()}
    />
  );
}
